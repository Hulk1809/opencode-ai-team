import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {executionIdentity,hasVerifiedStop,verifyExecutionStop} from '../src/peer-native.mjs';
import {cancelExecutionRPC} from '../src/peer-cancel-rpc.mjs';
import {issueOwnerGrant} from '../src/pilot-owner-authority.mjs';
import {PEER_GENERATION,planHash} from '../src/peer-team.mjs';
import {createIntegrationAuthority,integrateReviewedTask} from '../src/peer-integration.mjs';
import {reportBody,writeReport} from '../src/pilot-reports.mjs';
import {evaluateEffectivePermissions,evaluateCostAndStopControl} from '../src/peer-security.mjs';
import {ownerSummary,ROUND_MS,LEASE_MS} from '../src/peer-protocol.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@localhost','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function inHome(home,fn){const old=process.env.HOME;process.env.HOME=home;try{return await fn();}finally{process.env.HOME=old;}}

function setupFixture(){
  const home=mkdtempSync('/tmp/b12-'),root=join(home,'repo');mkdirSync(root);
  git(root,'init');writeFileSync(join(root,'a.txt'),'base-a\n');writeFileSync(join(root,'b.txt'),'base-b\n');git(root,'add','.');git(root,'commit','-m','base');
  mkdirSync(join(home,'.repo-integrations'));
  let interrupts=0,failInterrupt=false;
  const members=[1,2,3,4].map(i=>{
    const dir=join(home,`peer-${i}`),branch=`peer-${i}`;
    git(root,'worktree','add','-b',branch,dir);
    return {id:`peer-${i}`,role:`peer-${i}`,sessionID:`s${i}`,directory:dir,branch,agent:'build',modelDefault:{providerID:'p',id:'m',variant:'v'}};
  });
  const sessions=Object.fromEntries(members.map(m=>[m.sessionID,{id:m.sessionID,projectID:'proj',agent:'build',location:{directory:m.directory},model:m.modelDefault,outcome:'succeeded',permissions:[{action:'edit',resource:'*',effect:'deny'},{action:'shell',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'deny'}]}]));
  const active={},contexts={};
  const ctx={
    location:{directory:root,project:{canonical:root,id:'proj'}},
    options:{pilotStore:join(home,'store')},
    session:{
      get:async({sessionID})=>sessions[sessionID],
      active:async()=>active,
      context:async({sessionID})=>contexts[sessionID]??[],
      interrupt:async()=>{interrupts++;if(failInterrupt)throw Error('INTERRUPT_RPC_FAILED');}
    }
  };
  const c=new OfficialCoordinator(ctx);
  c.mutate(()=>({state:{schemaVersion:1,mode:'peer',generation:PEER_GENERATION,status:'ready',projectID:'proj',teamID:'team',canonicalRoot:root,isolation:'git-worktree',members,plans:[],tasks:[],messages:[],receipts:[],approvals:[],executions:[],integrations:[],artifacts:[]}}));
  const proto=async(peerOrSession,action,input,adapters)=>{
    const m=c.read().members.find(x=>x.id===peerOrSession||x.sessionID===peerOrSession);
    ctx.location.directory=m.directory;
    try{return await c.protocol(action,input,{sessionID:m.sessionID,agent:m.agent},adapters);}
    finally{ctx.location.directory=root;}
  };
  return {home,root,c,proto,sessions,active,contexts,getInterrupts:()=>interrupts,setFailInterrupt:v=>{failInterrupt=v;}};
}

function addReport(c,input,memberID){
  return c.mutate(s=>{
    const m=s.members.find(x=>x.id===memberID);
    const r=reportBody(input,s,m);
    writeReport(c.directory,r);
    s.artifacts??=[];s.artifacts.push(r);
    return {value:r};
  });
}

test('Stage 2: verify-stop adapter enforces live host status, context quiescence, receipt binding and coordinator protocol gates',async()=>{
  const f=setupFixture();
  await inHome(f.home,async()=>{
    const plan=await f.c.ownerPlan({requestID:'p1',expectedVersion:0,text:'# Plan',acceptanceCriteria:['ok'],approvedScopeRef:'scope-1'});
    const base={planID:plan.planID,planVersion:1,projectID:'proj',teamID:'team',canonicalRoot:f.root};
    for(const [i,p] of ['peer-1','peer-2','peer-3','peer-4'].entries())await f.proto(`s${i+1}`,'discuss',{...base,requestID:`d-${p}`,round:1,text:'ok',risk:'none'});
    await f.proto('s1','close_round',{...base,requestID:'cr1',round:1});
    const proposed=await f.proto('s1','propose',{...base,requestID:'pr1',text:'task',dependencies:[],files:['a.txt'],requiredCapabilities:[],acceptanceCriteria:['ok'],requiredChecks:['npm test']});
    for(const [i,p] of ['peer-1','peer-2','peer-3','peer-4'].entries())await f.proto(`s${i+1}`,'discuss',{...base,requestID:`d2-${p}`,round:2,text:'ok',risk:'none'});
    await f.proto('s1','close_round',{...base,requestID:'cr2',round:2});
    await f.proto('s1','close_round',{...base,requestID:'cr3',round:3},{now:Date.now()+ROUND_MS*10});
    const rdy=await f.proto('s1','ready',{...base,requestID:'rd1',taskID:proposed.id,taskVersion:1,ownershipGeneration:0});
    const claimed=await f.proto('s1','claim',{...base,requestID:'cl1',taskID:proposed.id,taskVersion:rdy.taskVersion,ownershipGeneration:0});
    const now0=Date.now();
    const running=await f.proto('s1','start',{...base,requestID:'st1',taskID:proposed.id,taskVersion:claimed.taskVersion,ownershipGeneration:1,leaseID:claimed.lease.id},{now:now0,admit:()=>true});

    const execRow=f.c.read().executions.at(-1);
    const id=executionIdentity(f.c.read(),running);
    assert.equal(hasVerifiedStop(f.c.read(),running),false);

    // Authenticated Owner cancel records durable cancelling state; active session prevents stop verification.
    f.active.s1={type:'running'};
    const grant=issueOwnerGrant({root:f.root,projectID:'proj',operation:'cancelExecution',generation:PEER_GENERATION,requestID:'cancel-1',planHash:planHash({executionID:execRow.id,identity:id})});
    const cancelled=await cancelExecutionRPC(f.c,{directory:f.root,authorization:grant,generation:PEER_GENERATION,requestID:'cancel-1',executionID:execRow.id,identity:id});
    assert.equal(cancelled.state,'cancelling');
    assert.equal(cancelled.cancellation.state,'requested');
    assert.equal(cancelled.observation,'running');

    await assert.rejects(()=>verifyExecutionStop(f.c,execRow.id,{verifyStop:async()=>({stopped:true,executionID:execRow.id,identity:id,receiptID:'stop-1'})}),/PEER_STOP_NOT_PROVEN/);
    delete f.active.s1;
    f.contexts.s1=[{type:'shell',status:'running'}];
    await assert.rejects(()=>verifyExecutionStop(f.c,execRow.id,{verifyStop:async()=>({stopped:true,executionID:execRow.id,identity:id,receiptID:'stop-1'})}),/PEER_STOP_NOT_PROVEN/);
    f.contexts.s1=[];

    // Coordinator reconcile/submit transitions reject while execution is not stop-verified.
    await assert.rejects(()=>f.proto('s2','reconcile',{...base,requestID:'rec-fail',taskID:running.id,taskVersion:running.taskVersion,ownershipGeneration:1},{now:now0+LEASE_MS*10}),/PROTOCOL_STOP_NOT_PROVEN/);

    // Once session is not active, context is quiet, and outcome is terminal, adapter proof succeeds and is idempotent.
    const verified=await verifyExecutionStop(f.c,execRow.id,{verifyStop:async(row,{session})=>{assert.equal(session.outcome,'succeeded');return {stopped:true,executionID:row.id,identity:row.identity,receiptID:'stop-1'};}});
    assert.equal(verified.state,'stop-verified');
    assert.equal(hasVerifiedStop(f.c.read(),f.c.read().tasks[0]),true);
    await assert.rejects(()=>verifyExecutionStop(f.c,execRow.id,{verifyStop:async()=>({stopped:true,executionID:execRow.id,identity:id,receiptID:'stop-conflict'})}),/PEER_STOP_IDEMPOTENCY_CONFLICT/);
  });
});

test('Stage 3 & 6: 4-peer end-to-end contract, conflict rework recovery, authorized integration and ownerSummary',async()=>{
  const f=setupFixture();
  await inHome(f.home,async()=>{
    // Plan v1 requires Owner approval when peer flags scope risk.
    const plan=await f.c.ownerPlan({requestID:'p-e2e',expectedVersion:0,text:'# E2E Plan',acceptanceCriteria:['all integrated'],approvedScopeRef:'scope-e2e'});
    const base={planID:plan.planID,planVersion:1,projectID:'proj',teamID:'team',canonicalRoot:f.root};
    await f.proto('peer-1','discuss',{...base,requestID:'d1-1',round:1,text:'scope review',risk:'scope'});
    for(const p of ['peer-2','peer-3','peer-4'])await f.proto(p,'discuss',{...base,requestID:`d1-${p}`,round:1,text:'ack',risk:'none'});
    await f.proto('peer-1','close_round',{...base,requestID:'cr-1',round:1});

    const t1=await f.proto('peer-1','propose',{...base,requestID:'prop-1',text:'Task 1',dependencies:[],files:['a.txt'],requiredCapabilities:[],acceptanceCriteria:['a.txt updated'],requiredChecks:['npm test']});
    const t2=await f.proto('peer-2','propose',{...base,requestID:'prop-2',text:'Task 2',dependencies:[t1.id],files:['b.txt'],requiredCapabilities:[],acceptanceCriteria:['b.txt updated'],requiredChecks:['npm test']});
    const b1=await f.proto('peer-1','bid',{...base,requestID:'bid-1',taskID:t1.id,taskVersion:1,ownershipGeneration:0});
    const b2=await f.proto('peer-2','bid',{...base,requestID:'bid-2',taskID:t2.id,taskVersion:1,ownershipGeneration:0});

    for(let r=2;r<=3;r++)await f.proto('peer-1','close_round',{...base,requestID:`cr-${r}`,round:r},{now:Date.now()+r*ROUND_MS*10});

    // Ready blocked until Owner approves plan; once approved, t1 and t2 become READY, but t2 is blocked by dependency t1.
    await assert.rejects(()=>f.proto('peer-1','ready',{...base,requestID:'rdy-blocked',taskID:t1.id,taskVersion:b1.taskVersion,ownershipGeneration:0}),/PROTOCOL_NOT_READY/);
    await f.c.ownerPlan({requestID:'rev-plan-1',planID:plan.planID,expectedVersion:1,digest:plan.digest,decision:'approve'});
    const rdy1=await f.proto('peer-1','ready',{...base,requestID:'rdy-1',taskID:t1.id,taskVersion:b1.taskVersion,ownershipGeneration:0});
    const rdy2=await f.proto('peer-2','ready',{...base,requestID:'rdy-2',taskID:t2.id,taskVersion:b2.taskVersion,ownershipGeneration:0});
    await assert.rejects(()=>f.proto('peer-2','claim',{...base,requestID:'cl-dep-blocked',taskID:t2.id,taskVersion:rdy2.taskVersion,ownershipGeneration:0}),/PROTOCOL_DEPENDENCIES_OR_STATE/);

    // Claim and start t1 with controlled admission.
    const c1=await f.proto('peer-1','claim',{...base,requestID:'cl-1',taskID:t1.id,taskVersion:rdy1.taskVersion,ownershipGeneration:0});
    const s1=await f.proto('peer-1','start',{...base,requestID:'st-1',taskID:t1.id,taskVersion:c1.taskVersion,ownershipGeneration:1,leaseID:c1.lease.id},{admit:()=>true});
    const ex1=f.c.read().executions.at(-1);
    await verifyExecutionStop(f.c,ex1.id,{verifyStop:async r=>({stopped:true,executionID:r.id,identity:r.identity,receiptID:'rcpt-t1-r1'})});

    // Commit in peer-1 worktree that will conflict with a root advance, to test conflict recovery.
    const m1=f.c.read().members.find(m=>m.id==='peer-1');
    const m2=f.c.read().members.find(m=>m.id==='peer-2');
    writeFileSync(join(m1.directory,'a.txt'),'peer1-v1\n');
    git(m1.directory,'add','a.txt');git(m1.directory,'commit','-m','t1 v1');
    const commitV1=git(m1.directory,'rev-parse','HEAD');
    writeFileSync(join(f.root,'a.txt'),'root-conflict\n');
    git(f.root,'add','a.txt');git(f.root,'commit','-m','root conflict');
    const conflictBase=git(f.root,'rev-parse','HEAD');

    const sub1=addReport(f.c,{taskID:t1.id,text:`commit ${commitV1}`,files:['a.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'a.txt',remaining:'none',status:'completed'},'peer-1');
    const subTask1=await f.proto('peer-1','submit',{...base,requestID:'sub-1',taskID:t1.id,taskVersion:s1.taskVersion,ownershipGeneration:1,leaseID:c1.lease.id,reportID:sub1.id});
    const revPeer1=f.c.read().members.find(m=>m.id===subTask1.reviewer);
    const rev1=addReport(f.c,{taskID:t1.id,text:`reviewed ${commitV1}`,files:['a.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'a.txt',remaining:'none',status:'completed'},revPeer1.id);
    const revTask1=await f.proto(revPeer1.id,'review',{...base,requestID:'rev-1',taskID:t1.id,taskVersion:subTask1.taskVersion,ownershipGeneration:1,approved:true,reportID:rev1.id});

    const intDir1=join(f.home,'.repo-integrations','int-1');
    const intReq1={requestID:'int-1',taskID:t1.id,taskVersion:revTask1.taskVersion,ownershipGeneration:1,workRevision:1,baseCommit:conflictBase,sourceCommit:commitV1,directory:intDir1};
    const intGrant1=issueOwnerGrant({root:f.root,projectID:'proj',operation:'integrateTask',generation:PEER_GENERATION,requestID:'int-1',planHash:planHash(intReq1)});
    const conflictReceipt=await integrateReviewedTask(f.c,intReq1,createIntegrationAuthority(f.c,{authorization:intGrant1}));
    assert.equal(conflictReceipt.state,'conflict');
    await assert.rejects(()=>f.proto(revPeer1.id,'integrate',{...base,requestID:'int-Blocked',taskID:t1.id,taskVersion:revTask1.taskVersion,ownershipGeneration:1}),/PROTOCOL_MERGE_NOT_PROVEN/);

    // Recover via review(approved:false) -> REWORK (workRevision 2) -> start -> resolve conflict -> re-review -> integrate -> done.
    const rw1=await f.proto(revPeer1.id,'review',{...base,requestID:'rw-1',taskID:t1.id,taskVersion:revTask1.taskVersion,ownershipGeneration:1,approved:false,reportID:rev1.id});
    assert.equal(rw1.status,'REWORK');
    assert.equal(rw1.workRevision,2);
    const s1v2=await f.proto('peer-1','start',{...base,requestID:'st-1v2',taskID:t1.id,taskVersion:rw1.taskVersion,ownershipGeneration:1,leaseID:rw1.lease.id},{admit:()=>true});
    const ex1v2=f.c.read().executions.at(-1);
    await verifyExecutionStop(f.c,ex1v2.id,{verifyStop:async r=>({stopped:true,executionID:r.id,identity:r.identity,receiptID:'rcpt-t1-r2'})});

    git(m1.directory,'reset','--hard',conflictBase);
    writeFileSync(join(m1.directory,'a.txt'),'peer1-resolved\n');
    git(m1.directory,'add','a.txt');git(m1.directory,'commit','-m','t1 v2 resolved');
    const commitV2=git(m1.directory,'rev-parse','HEAD');
    const sub1v2=addReport(f.c,{taskID:t1.id,text:`commit ${commitV2}`,files:['a.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'a.txt',remaining:'none',status:'completed'},'peer-1');
    const subTask1v2=await f.proto('peer-1','submit',{...base,requestID:'sub-1v2',taskID:t1.id,taskVersion:s1v2.taskVersion,ownershipGeneration:1,leaseID:rw1.lease.id,reportID:sub1v2.id});
    const rev1v2=addReport(f.c,{taskID:t1.id,text:`reviewed ${commitV2}`,files:['a.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'a.txt',remaining:'none',status:'completed'},revPeer1.id);
    const revTask1v2=await f.proto(revPeer1.id,'review',{...base,requestID:'rev-1v2',taskID:t1.id,taskVersion:subTask1v2.taskVersion,ownershipGeneration:1,approved:true,reportID:rev1v2.id});

    const intDir2=join(f.home,'.repo-integrations','int-2');
    const intReq2={requestID:'int-2',taskID:t1.id,taskVersion:revTask1v2.taskVersion,ownershipGeneration:1,workRevision:2,baseCommit:conflictBase,sourceCommit:commitV2,directory:intDir2};
    const intGrant2=issueOwnerGrant({root:f.root,projectID:'proj',operation:'integrateTask',generation:PEER_GENERATION,requestID:'int-2',planHash:planHash(intReq2)});
    const merged1=await integrateReviewedTask(f.c,intReq2,createIntegrationAuthority(f.c,{authorization:intGrant2}));
    assert.equal(merged1.state,'merged');
    const intTask1=await f.proto(revPeer1.id,'integrate',{...base,requestID:'proto-int-1',taskID:t1.id,taskVersion:revTask1v2.taskVersion,ownershipGeneration:1});
    await f.proto(revPeer1.id,'done',{...base,requestID:'comp-1',taskID:t1.id,taskVersion:intTask1.taskVersion,ownershipGeneration:1});

    // Now dependent task t2 is ready and completes end-to-end.
    const c2=await f.proto('peer-2','claim',{...base,requestID:'cl-2',taskID:t2.id,taskVersion:rdy2.taskVersion,ownershipGeneration:0});
    const s2=await f.proto('peer-2','start',{...base,requestID:'st-2',taskID:t2.id,taskVersion:c2.taskVersion,ownershipGeneration:1,leaseID:c2.lease.id},{admit:()=>true});
    const ex2=f.c.read().executions.at(-1);
    await verifyExecutionStop(f.c,ex2.id,{verifyStop:async r=>({stopped:true,executionID:r.id,identity:r.identity,receiptID:'rcpt-t2-r1'})});

    git(m2.directory,'reset','--hard',conflictBase);
    writeFileSync(join(m2.directory,'b.txt'),'peer2-v1\n');
    git(m2.directory,'add','b.txt');git(m2.directory,'commit','-m','t2 v1');
    const commitT2=git(m2.directory,'rev-parse','HEAD');
    const sub2=addReport(f.c,{taskID:t2.id,text:`commit ${commitT2}`,files:['b.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'b.txt',remaining:'none',status:'completed'},'peer-2');
    const subTask2=await f.proto('peer-2','submit',{...base,requestID:'sub-2',taskID:t2.id,taskVersion:s2.taskVersion,ownershipGeneration:1,leaseID:c2.lease.id,reportID:sub2.id});
    const revPeer2=f.c.read().members.find(m=>m.id===subTask2.reviewer);
    const rev2=addReport(f.c,{taskID:t2.id,text:`reviewed ${commitT2}`,files:['b.txt'],commands:[{command:'npm test',exitCode:0,output:'ok'}],diff:'b.txt',remaining:'none',status:'completed'},revPeer2.id);
    const revTask2=await f.proto(revPeer2.id,'review',{...base,requestID:'rev-2',taskID:t2.id,taskVersion:subTask2.taskVersion,ownershipGeneration:1,approved:true,reportID:rev2.id});

    const intDir3=join(f.home,'.repo-integrations','int-3');
    const intReq3={requestID:'int-3',taskID:t2.id,taskVersion:revTask2.taskVersion,ownershipGeneration:1,workRevision:1,baseCommit:conflictBase,sourceCommit:commitT2,directory:intDir3};
    const intGrant3=issueOwnerGrant({root:f.root,projectID:'proj',operation:'integrateTask',generation:PEER_GENERATION,requestID:'int-3',planHash:planHash(intReq3)});
    const merged2=await integrateReviewedTask(f.c,intReq3,createIntegrationAuthority(f.c,{authorization:intGrant3}));
    assert.equal(merged2.state,'merged');
    const intTask2=await f.proto(revPeer2.id,'integrate',{...base,requestID:'proto-int-2',taskID:t2.id,taskVersion:revTask2.taskVersion,ownershipGeneration:1});
    await f.proto(revPeer2.id,'done',{...base,requestID:'comp-2',taskID:t2.id,taskVersion:intTask2.taskVersion,ownershipGeneration:1});

    const summary=ownerSummary(f.c.read());
    assert.equal(summary.allDone,true);
    assert.equal(summary.counts.DONE,2);
    assert.equal(summary.executionMode,'controlled-adapter-only');
    assert.equal(summary.tasks.every(t=>t.resultCommit&&t.integrationReceiptID),true);
  });
});

test('Stage 4 & 5: effective permissions chain and cost/quota/hard-stop evaluator enforce fail-closed boundaries',async()=>{
  const f=setupFixture();
  const state=f.c.read(),member=state.members[0],session=f.sessions[member.sessionID];
  writeFileSync(join(member.directory,'allowed.txt'),'ok');
  const approval={id:'app-1',ownerID:'owner',projectID:'proj',teamID:'team',canonicalRoot:f.root,generation:PEER_GENERATION,repository:f.root,branches:[member.branch],operations:['read','edit'],resources:[join(member.directory,'allowed.txt')],issuedAt:1,expiresAt:2000,revokedAt:null,budget:{currency:'USD',maxCostMicros:1000,maxPrompts:4,maxConcurrent:4,maxRetries:1}};
  const op={action:'edit',resource:join(member.directory,'allowed.txt'),relativePath:'allowed.txt',repository:f.root,branch:member.branch};

  // Without host containment attestation, coordinator checks pass but effective permissions stay blocked.
  const unattested=evaluateEffectivePermissions({state,member,session,approval,operation:op,ownerVerified:true,revocationVerified:true,hostAttested:false,now:100});
  assert.equal(unattested.allowed,false);
  assert.equal(unattested.coordinatorChecks.scopeOk,true);
  assert.equal(unattested.sharedOsUidWarning,true);
  assert.ok(unattested.blockers.includes('HOST_CONTAINMENT_NOT_PROVEN'));

  const attested=evaluateEffectivePermissions({state,member,session,approval,operation:op,ownerVerified:true,revocationVerified:true,hostAttested:true,now:100});
  assert.equal(attested.allowed,true);

  // Cost & stop control rejects empty cost=[], zero cost, null usage, or unverified hard cap/stop.
  const model={providerID:'p',id:'m',variant:'v'};
  const zeroCost=evaluateCostAndStopControl({state,approval,catalog:[{providerID:'p',id:'m',variants:['v'],cost:[{input:0,output:0}]}],model,usage:null,now:100});
  assert.equal(zeroCost.unattendedPaidExecution,'BLOCKED');
  assert.ok(zeroCost.blockers.includes('PRICING_NOT_PROVEN_OR_ZERO'));
  assert.ok(zeroCost.blockers.includes('QUOTA_NOT_PROVEN'));
  assert.ok(zeroCost.blockers.includes('HARD_BUDGET_NOT_PROVEN'));
  assert.ok(zeroCost.blockers.includes('NATIVE_ADMISSION_STOP_NOT_PROVEN'));

  const proven=evaluateCostAndStopControl({
    state,approval,
    catalog:[{providerID:'p',id:'m',variants:['v'],cost:[{input:2,output:8}]}],
    model,
    usage:[{providerID:'p',ProviderName:'P',status:'ok',entries:[{label:'Monthly',used:10,limit:100}]}],
    session:{cost:0.05,tokens:{input:100,output:50}},
    spentMicros:100,promptsUsed:1,activeCount:1,retriesUsed:0,
    providerCapVerified:true,stopVerified:true,now:100
  });
  assert.equal(proven.unattendedPaidExecution,'ALLOWED');
  assert.equal(proven.sessionUsageProven,true);
  assert.equal(proven.blockers.length,0);
});
