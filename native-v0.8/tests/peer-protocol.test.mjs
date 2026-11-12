import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {ingestPlan,protocolAction,DISCUSSION_ROUNDS,ROUND_MS,LEASE_MS} from '../src/peer-protocol.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';

function fixture(){
  const ctx={root:'/project',projectID:'project',teamID:'team'};
  let state={mode:'peer',status:'ready',canonicalRoot:ctx.root,projectID:ctx.projectID,teamID:ctx.teamID,members:Array.from({length:4},(_,i)=>({id:`peer-${i+1}`,role:`peer-${i+1}`,sessionID:`ses_${i+1}`})),tasks:[],messages:[]},seq=0,now=0;
  const source={requestID:'plan-1',expectedVersion:0,text:'# Plan',acceptanceCriteria:['Tests pass'],approvedScopeRef:'scope-reviewed-1'};
  const p=ingestPlan(state,source,ctx,undefined,now);
  const payload=extra=>({requestID:`r-${++seq}`,planID:p.planID,planVersion:p.version,projectID:ctx.projectID,teamID:ctx.teamID,canonicalRoot:ctx.root,...extra});
  function call(actor,action,extra={},options={}){const copy=structuredClone(state);const result=protocolAction(copy,actor,action,payload(extra),ctx,{now,...options});state=copy;return result;}
  const taskInput=t=>({taskID:t.id,taskVersion:t.taskVersion,ownershipGeneration:t.ownershipGeneration});
  const propose=(extra={})=>call('peer-1','propose',{text:'Work',dependencies:[],files:['src/a'],requiredCapabilities:['collaboration'],acceptanceCriteria:['Pass'],requiredChecks:['node check.mjs'],...extra});
  const close=()=>{for(let i=0;i<DISCUSSION_ROUNDS;i++){now+=ROUND_MS;call('peer-1','close_round',{round:i+1});}};
  return {ctx,p,source,payload,call,taskInput,propose,close,get state(){return state;},set now(n){now=n;},get now(){return now;}};
}

test('failed scoped attempt reconciles early only for assignee with verified stop',()=>{
  const f=fixture();let t=f.propose();f.close();t=f.call('peer-1','ready',f.taskInput(t));
  t=f.call('peer-1','claim',f.taskInput(t));
  t=f.call('peer-1','start',{...f.taskInput(t),leaseID:t.lease.id},{admit:()=>true});
  const row=f.state.executions.at(-1),stored=f.state.tasks.find(x=>x.id===t.id);
  row.state='stop-verified';row.stopReceipt={outcome:'failed'};stored.executionState='stopped';
  assert.throws(()=>f.call('peer-1','reconcile',f.taskInput(t),{stopped:()=>false}),/LEASE_NOT_EXPIRED/);
  assert.throws(()=>f.call('peer-2','reconcile',f.taskInput(t),{stopped:()=>true}),/LEASE_NOT_EXPIRED/);
  row.stopReceipt.outcome='success';
  assert.throws(()=>f.call('peer-1','reconcile',f.taskInput(t),{stopped:()=>true}),/LEASE_NOT_EXPIRED/);
  row.stopReceipt.outcome='failed';
  const next=f.call('peer-1','reconcile',f.taskInput(t),{stopped:()=>true});
  assert.equal(next.status,'READY');assert.equal(next.executionState,'not-started');
  assert.equal(next.workRevision,t.workRevision+1);assert.equal(next.ownershipGeneration,t.ownershipGeneration+1);
});

test('Owner task assignment pins claimant and independent reviewer without execution grant',()=>{
  const f=fixture();f.close();
  const input={text:'Owner work',dependencies:[],files:['src/a'],requiredCapabilities:['collaboration'],acceptanceCriteria:['Pass'],requiredChecks:['node check.mjs'],assignedPeer:'peer-3',reviewPeer:'peer-4'};
  assert.throws(()=>f.call('owner','propose',input),/MEMBER/);
  assert.throws(()=>f.call('owner','propose',{...input,reviewPeer:'peer-3'},{owner:true}),/INDEPENDENT_REVIEW/);
  assert.throws(()=>f.call('owner','propose',{...input,assignedPeer:'foreign'},{owner:true}),/MEMBER/);
  assert.throws(()=>f.call('owner','propose',{...input,files:['../escape']},{owner:true}),/PATH/);
  assert.throws(()=>f.call('owner','propose',{...input,dependencies:['unknown']},{owner:true}),/DEPENDENCY/);
  let t=f.call('owner','propose',input,{owner:true});assert.equal(t.assignmentSource,'owner');
  const replay=f.payload(input),copy=structuredClone(f.state);
  const first=protocolAction(copy,'owner','propose',replay,f.ctx,{owner:true});
  assert.equal(protocolAction(copy,'owner','propose',replay,f.ctx,{owner:true}).id,first.id);
  assert.throws(()=>protocolAction(copy,'owner','propose',{...replay,assignedPeer:'peer-2'},f.ctx,{owner:true}),/IDEMPOTENCY_CONFLICT/);
  t=f.call('peer-1','ready',f.taskInput(t));
  assert.throws(()=>f.call('peer-1','claim',f.taskInput(t)),/CLAIM_DENIED/);
  t=f.call('peer-3','claim',f.taskInput(t));assert.equal(t.reviewer,'peer-4');
  assert.throws(()=>f.call('peer-3','start',{...f.taskInput(t),leaseID:t.lease.id}),/EXECUTION_NOT_AUTHORIZED/);
  t=f.call('peer-3','release',{...f.taskInput(t),leaseID:t.lease.id});
  assert.equal(t.assignedPeer,'peer-3');
  assert.throws(()=>f.call('peer-2','claim',f.taskInput(t)),/CLAIM_DENIED/);
});

test('all four peers read same bound plan; duplicate, cross-project and version changes',()=>{
  const f=fixture();for(const m of f.state.members)assert.equal(f.call(m.id,'read').plan.digest,f.p.digest);
  assert.equal(ingestPlan(f.state,f.source,f.ctx).version,1);
  assert.throws(()=>ingestPlan(f.state,{...f.source,text:'Changed'},f.ctx),/IDEMPOTENCY/);
  assert.throws(()=>f.call('peer-1','read',{projectID:'other'}),/SCOPE/);
  assert.throws(()=>f.call('peer-1','read',{canonicalRoot:'/other'}),/SCOPE/);
  assert.throws(()=>f.call('foreign','read'),/MEMBER/);
  const next=ingestPlan(f.state,{...f.source,requestID:'plan-2',planID:f.p.planID,expectedVersion:1,text:'Next'},f.ctx);
  assert.equal(next.version,2);assert.equal(f.state.plans.length,2);
  assert.throws(()=>f.call('peer-1','read'),/STALE_PLAN/);
});

test('bounded discussion, risk escalation, immutable DAG rejects cycles/unknown dependencies',()=>{
  const f=fixture(),t=f.propose();
  assert.throws(()=>f.propose({dependencies:[t.id,'future']}),/DEPENDENCY/);
  assert.throws(()=>f.call('peer-1','update',{...f.taskInput(t),dependencies:[t.id]}),/ACTION/);
  f.call('peer-1','discuss',{round:1,text:'Architecture requires Owner',risk:'architecture'});
  assert.throws(()=>f.call('peer-1','discuss',{round:1,text:'Again',risk:'none'}),/LIMIT/);
  assert.throws(()=>f.call('peer-1','close_round',{round:1}),/ROUND_OPEN/);
  f.close();assert.throws(()=>f.call('peer-1','close_round',{round:3}),/LIMIT/);
  assert.throws(()=>f.propose(),/LIMIT/);
  assert.throws(()=>f.call('peer-1','ready',f.taskInput(t)),/NOT_READY/);
});

test('deterministic claims, CAS, lease expiration and cancellation do not imply native stop',()=>{
  const f=fixture();let t=f.propose();f.close();t=f.call('peer-4','ready',f.taskInput(t));
  assert.throws(()=>f.call('peer-2','claim',f.taskInput(t)),/CLAIM_DENIED/);
  const stale=t;t=f.call('peer-1','claim',f.taskInput(t));assert.notEqual(t.assignee,t.reviewer);
  assert.throws(()=>f.call('peer-1','claim',f.taskInput(stale)),/STALE_TASK/);
  assert.throws(()=>f.call('peer-1','start',{...f.taskInput(t),leaseID:t.lease.id}),/EXECUTION_NOT_AUTHORIZED/);
  t=f.call('peer-1','start',{...f.taskInput(t),leaseID:t.lease.id},{admit:()=>true});
  assert.throws(()=>ingestPlan(f.state,{...f.source,requestID:'next',expectedVersion:1,planID:f.p.planID},f.ctx),/OUTSTANDING/);
  f.now=t.lease.expiresAt+1;
  assert.throws(()=>f.call('peer-1','renew',{...f.taskInput(t),leaseID:t.lease.id}),/LEASE_INVALID/);
  assert.throws(()=>f.call('peer-3','reconcile',f.taskInput(t)),/STOP_NOT_PROVEN/);
  t=f.call('peer-3','cancel',{...f.taskInput(t),text:'Cancel'});assert.equal(t.executionState,'outstanding');
  assert.throws(()=>f.call('peer-3','reconcile',f.taskInput(t)),/STOP_NOT_PROVEN/);
  t=f.call('peer-3','reconcile',f.taskInput(t),{stopped:()=>true});assert.equal(t.status,'CANCELLED');assert.equal(t.executionState,'stopped');
});

test('expired completed worker renews submission lease without changing ownership; no stop proof denies',()=>{
  const f=fixture();let t=f.propose();f.close();t=f.call('peer-1','ready',f.taskInput(t));t=f.call('peer-1','claim',f.taskInput(t));
  t=f.call('peer-1','start',{...f.taskInput(t),leaseID:t.lease.id},{admit:()=>true});
  f.state.tasks[0].executionState='stopped';f.now=t.lease.expiresAt+1;
  const input={...f.taskInput(t),leaseID:t.lease.id};
  assert.throws(()=>f.call('peer-1','renew',input),/LEASE_INVALID/);
  assert.throws(()=>f.call('peer-2','renew',input,{stopped:()=>true}),/LEASE_INVALID/);
  t=f.call('peer-1','renew',input,{stopped:()=>true});
  assert.equal(t.ownershipGeneration,input.ownershipGeneration);assert.equal(t.lease.expiresAt,f.now+LEASE_MS);assert.equal(t.status,'RUNNING');
});

test('dependencies gate admission; independent reports and reviewer gate DONE; rework invalidates evidence',()=>{
  const f=fixture();let a=f.propose(),b=f.propose({files:['src/b'],dependencies:[a.id]});f.close();
  a=f.call('peer-1','ready',f.taskInput(a));a=f.call('peer-1','claim',f.taskInput(a));
  b=f.call('peer-1','ready',f.taskInput(b));
  assert.throws(()=>f.call('peer-2','claim',f.taskInput(b)),/DEPENDENCIES/);
  a=f.call('peer-1','start',{...f.taskInput(a),leaseID:a.lease.id},{admit:()=>true});
  const addReport=(t,actor,id)=>{f.state.artifacts??=[];f.state.artifacts.push({id,taskID:t.id,owner:actor,sessionID:f.state.members.find(m=>m.id===actor).sessionID,projectID:'project',teamID:'team',status:'completed',planVersion:1,ownershipGeneration:t.ownershipGeneration,workRevision:t.workRevision,checks:[{command:'node check.mjs',exitCode:0}]});};
  addReport(a,'peer-1','primary');
  a=f.call('peer-1','submit',{...f.taskInput(a),leaseID:a.lease.id,reportID:'primary'},{stopped:()=>true,verifyReport:()=>true});
  assert.throws(()=>f.call('peer-4','reassign_review',f.taskInput(a)),/TIMEOUT/);
  const oldReviewer=a.reviewer;f.now+=LEASE_MS;
  a=f.call('peer-4','reassign_review',f.taskInput(a));assert.notEqual(a.reviewer,oldReviewer);assert.notEqual(a.reviewer,a.assignee);
  assert.throws(()=>f.call('peer-1','done',f.taskInput(a)),/INDEPENDENT/);
  assert.throws(()=>f.call('peer-1','review',{...f.taskInput(a),approved:true,reportID:'primary'}),/INDEPENDENT/);
  addReport(a,a.reviewer,'review');
  const reviewReport=f.state.artifacts.find(x=>x.id==='review');
  reviewReport.checks=[{command:'team_worktree verify',exitCode:0}];
  assert.throws(()=>f.call(a.reviewer,'review',{...f.taskInput(a),approved:true,reportID:'review'},{verifyReport:()=>true}),/PROTOCOL_VERIFICATION_REQUIRED: report.commands missing successful required checks \["node check.mjs"\]/);
  assert.equal(f.state.tasks.find(t=>t.id===a.id).status,'SUBMITTED');
  reviewReport.checks=[{command:'node check.mjs',exitCode:0}];
  a=f.call(a.reviewer,'review',{...f.taskInput(a),approved:true,reportID:'review'},{verifyReport:()=>true});
  a=f.call(a.reviewer,'integrate',f.taskInput(a),{verifyReport:()=>true});
  a=f.call(a.reviewer,'done',f.taskInput(a),{verifyReport:()=>true});assert.equal(a.status,'DONE');
  // Claim selection changes after upstream completion: peer-1 now has least primary load.
  b=f.call('peer-1','claim',f.taskInput(b));
  f.now=b.lease.expiresAt-1;
  b=f.call('peer-1','start',{...f.taskInput(b),leaseID:b.lease.id},{admit:()=>true});
  addReport(b,'peer-1','b-primary');b=f.call('peer-1','submit',{...f.taskInput(b),leaseID:b.lease.id,reportID:'b-primary'},{stopped:()=>true,verifyReport:()=>true});
  b=f.call(b.reviewer,'review',{...f.taskInput(b),approved:false});assert.equal(b.status,'REWORK');assert.equal(b.workRevision,2);
  b=f.call('peer-1','start',{...f.taskInput(b),leaseID:b.lease.id},{admit:()=>true});
  assert.throws(()=>f.call('peer-1','submit',{...f.taskInput(b),leaseID:b.lease.id,reportID:'b-primary'},{stopped:()=>true,verifyReport:()=>true}),/VERIFICATION/);
});

test('bids use capabilities without model-name authority; file conflicts and idle lease recovery',()=>{
  const f=fixture();let a=f.propose(),b=f.propose();
  a=f.call('peer-3','bid',f.taskInput(a));f.close();
  a=f.call('peer-4','ready',f.taskInput(a));
  assert.throws(()=>f.call('peer-1','claim',f.taskInput(a)),/CLAIM_DENIED/);
  a=f.call('peer-3','claim',f.taskInput(a));
  b=f.call('peer-4','ready',f.taskInput(b));
  assert.throws(()=>f.call('peer-1','claim',f.taskInput(b)),/FILE_CONFLICT/);
  f.now=a.lease.expiresAt+1;
  a=f.call('peer-2','reconcile',f.taskInput(a));assert.equal(a.status,'READY');assert.equal(a.assignee,'unclaimed');assert.equal(a.ownershipGeneration,2);
  b=f.call('peer-1','claim',f.taskInput(b));assert.equal(b.assignee,'peer-1');
  const g=fixture();assert.throws(()=>g.propose({requiredCapabilities:['unsupported']}),/NO_ELIGIBLE/);
});

test('coordinator persists managed Markdown, validates file scope, concurrent CAS and duplicate requests',async()=>{
  const root=mkdtempSync('/tmp/opencode/protocol-test-');
  const ctx={location:{directory:root,project:{canonical:root,id:'project'}},options:{pilotStore:join(root,'store')},session:{get:async({sessionID})=>({id:sessionID,projectID:'project',agent:'build',location:{directory:root}})}};
  const c=new OfficialCoordinator(ctx),other=new OfficialCoordinator(ctx);
  try{
    c.mutate(()=>({state:{mode:'peer',status:'ready',teamID:'team',projectID:'project',canonicalRoot:root,members:Array.from({length:4},(_,i)=>({id:`peer-${i+1}`,role:`peer-${i+1}`,sessionID:`ses_${i+1}`,agent:'build',directory:root})),tasks:[],messages:[]}}));
    const publication={requestID:'plan',expectedVersion:0,markdown:'# Managed plan',acceptanceCriteria:['Pass'],approvedScopeRef:'scope-1'};
    const p=await c.ownerPlan(publication);assert.match(p.fileID,/^planfile_/);assert.deepEqual(await c.ownerPlan(publication),p);
    await assert.rejects(c.ownerPlan({...publication,markdown:undefined,fileID:'../../secret',requestID:'bad',expectedVersion:1,planID:p.planID}),/TEXT|ATTACHMENT/);
    let seq=0;const payload=x=>({requestID:`r${++seq}`,planID:p.planID,planVersion:1,projectID:'project',teamID:'team',canonicalRoot:root,...x});
    const host={sessionID:'ses_1',agent:'build'};
    const discovered=await c.protocol('read',{},host);
    assert.equal(discovered.plan.version,1);assert.equal(discovered.policy.executionEnabled,false);
    assert.deepEqual(discovered.binding,{projectID:'project',teamID:'team',canonicalRoot:root,planID:p.planID,planVersion:1});
    await assert.rejects(c.protocol('read',{}, {...host,sessionID:'unknown'}),/PILOT_MEMBER_REQUIRED/);
    await assert.rejects(c.protocol('propose',{},host),/PROTOCOL_/);
    let t=await c.protocol('propose',payload({text:'Work',files:[],dependencies:[],requiredCapabilities:[],acceptanceCriteria:['Pass'],requiredChecks:['check']}),host);
    c.mutate(state=>{state.plans[0].discussionClosed=true;return {};});
    t=await c.protocol('ready',payload({taskID:t.id,taskVersion:t.taskVersion,ownershipGeneration:0}),host);
    const request=payload({taskID:t.id,taskVersion:t.taskVersion,ownershipGeneration:0});
    const results=await Promise.allSettled([c.protocol('claim',request,host),other.protocol('claim',{...request,requestID:'other'},host)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const claimed=results.find(r=>r.status==='fulfilled').value;
    assert.deepEqual(await c.protocol('claim',request,host),claimed);
    await assert.rejects(c.protocol('start',payload({taskID:t.id,taskVersion:claimed.taskVersion,ownershipGeneration:claimed.ownershipGeneration,leaseID:claimed.lease.id}),host),/PEER_LIVE_EXECUTION_BLOCKED/);
    const deniedStart=payload({taskID:t.id,taskVersion:claimed.taskVersion,ownershipGeneration:claimed.ownershipGeneration,leaseID:claimed.lease.id});
    await assert.rejects(c.protocol('start',deniedStart,host),/PEER_LIVE_EXECUTION_BLOCKED/);
    await assert.rejects(c.protocol('start',deniedStart,host),/PEER_LIVE_EXECUTION_BLOCKED/);
    assert.equal(c.read().tasks[0].executionState,'not-started');
    await assert.rejects(c.protocol('claim',{...request,taskVersion:999},host),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(c.execute('ack',{taskID:t.id,status:'done'},host),/VERSIONED_ACTION/);
    assert.deepEqual(new OfficialCoordinator(ctx).read(),c.read());
    await assert.rejects(c.protocol('read',payload({}),{sessionID:'ses_foreign',agent:'build'}),/MEMBER/);
    const next=await c.ownerPlan({requestID:'by-file',expectedVersion:1,planID:p.planID,fileID:p.fileID,acceptanceCriteria:['Pass'],approvedScopeRef:'scope-1'});
    assert.equal(next.version,2);assert.equal(next.digest,p.digest);assert.equal(c.read().tasks[0].status,'CANCELLED');
    await assert.rejects(c.protocol('read',payload({}),host),/STALE_PLAN/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('separate processes contend for one durable claim; exactly one ownership generation wins',async()=>{
  const root=mkdtempSync('/tmp/opencode/protocol-race-');
  const ctx={location:{directory:root,project:{canonical:root,id:'project'}},options:{pilotStore:join(root,'store')}};
  const c=new OfficialCoordinator(ctx),f=fixture();let t=f.propose({files:[]});f.close();t=f.call('peer-1','ready',f.taskInput(t));
  const state=structuredClone(f.state);state.canonicalRoot=root;for(const p of state.plans)p.canonicalRoot=root;
  for(const m of state.members){m.agent='build';m.directory=root;}
  c.mutate(()=>({state}));
  try{
    const moduleURL=new URL('../src/official-coordinator.mjs',import.meta.url).href;
    const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
      const input={...f.payload(f.taskInput(t)),canonicalRoot:root,requestID:`race-${i}`};
      const code=`import {OfficialCoordinator} from ${JSON.stringify(moduleURL)};const ctx=${JSON.stringify(ctx)};ctx.session={get:async({sessionID})=>({id:sessionID,projectID:'project',agent:'build',location:{directory:${JSON.stringify(root)}}})};try{await new OfficialCoordinator(ctx).protocol('claim',${JSON.stringify(input)},{sessionID:'ses_1',agent:'build'});}catch(e){if(!/STALE_TASK|BUSY_OR_RECOVERY/.test(e.message)){console.error(e);process.exitCode=3}else process.exitCode=2}`;
      const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>{error+=b;});child.on('error',reject);child.on('exit',status=>resolve({status,error}));
    })));
    assert.equal(results.filter(r=>r.status===0).length,1,JSON.stringify(results));
    assert.equal(results.filter(r=>r.status===2).length,7,JSON.stringify(results));
    assert.equal(c.read().tasks[0].ownershipGeneration,1);assert.equal(c.read().tasks[0].assignee,'peer-1');
  }finally{rmSync(root,{recursive:true,force:true});}
});
