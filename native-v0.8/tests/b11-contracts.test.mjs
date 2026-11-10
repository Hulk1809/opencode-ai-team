import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {executionIdentity,verifyExecutionStop,requestCancellation} from '../src/peer-native.mjs';
import {cancelExecutionRPC} from '../src/peer-cancel-rpc.mjs';
import {issueOwnerGrant} from '../src/pilot-owner-authority.mjs';
import {PEER_GENERATION,planHash} from '../src/peer-team.mjs';
import {integrateReviewedTask} from '../src/peer-integration.mjs';
import {reportBody,writeReport} from '../src/pilot-reports.mjs';
import {selectEngine} from '../src/peer-engine-selection.mjs';
import {protocolAction} from '../src/peer-protocol.mjs';

function fixture(){
  const home=mkdtempSync('/tmp/b11-'),root=join(home,'repo');mkdirSync(root);
  let interrupts=0;
  const members=[1,2,3,4].map(i=>({id:`peer-${i}`,role:`peer-${i}`,sessionID:`s${i}`,directory:root,agent:'build',modelDefault:{providerID:'fixture',id:'model',variant:'default'}}));
  const ctx={location:{directory:root,project:{canonical:root,id:'project'}},options:{pilotStore:join(home,'store')},session:{get:async()=>({id:'s1',projectID:'project',agent:'build',location:{directory:root},model:members[0].modelDefault,outcome:'succeeded'}),active:async()=>({}),interrupt:async()=>{interrupts++;}}};
  const c=new OfficialCoordinator(ctx),t={protocolVersion:1,id:'t',planID:'p',planVersion:1,taskVersion:3,ownershipGeneration:1,workRevision:1,assignee:'peer-1',reviewer:'peer-2',status:'REVIEW',executionState:'stopped',requiredChecks:['check'],dependencies:[],files:['file.txt'],text:'work',review:{memberID:'peer-2',workRevision:1,ownershipGeneration:1}};
  c.mutate(()=>({state:{mode:'peer',status:'ready',canonicalRoot:root,projectID:'project',teamID:'team',members,tasks:[t],plans:[{planID:'p',version:1}],messages:[],executions:[{id:'e',taskID:'t',sessionID:'s1',identity:executionIdentity({projectID:'project',teamID:'team',members},t)}]}}));
  return {home,root,c,ctx,get interrupts(){return interrupts;}};
}
function grant(f,overrides={}){
  const identity=f.c.read().executions[0].identity,input={directory:f.root,generation:PEER_GENERATION,requestID:'cancel',executionID:'e',identity,...overrides};
  const old=process.env.HOME;process.env.HOME=f.home;
  try{input.authorization=issueOwnerGrant({root:f.root,projectID:'project',operation:'cancelExecution',generation:input.generation,requestID:input.requestID,planHash:planHash({executionID:input.executionID,identity:input.identity})});}finally{process.env.HOME=old;}
  return input;
}
async function inHome(f,fn){const old=process.env.HOME;process.env.HOME=f.home;try{return await fn();}finally{process.env.HOME=old;}}

test('B1.1 cancellation: authenticated exact grant, tamper, replay, generation and terminal not stop',async()=>{
  const f=fixture(),input=grant(f);
  await inHome(f,async()=>{
    await assert.rejects(cancelExecutionRPC(f.c,{...input,authorization:'forged'}));
    await assert.rejects(cancelExecutionRPC(f.c,{...input,directory:'/other'}));
    await assert.rejects(cancelExecutionRPC(f.c,{...input,generation:'old'}));
    await assert.rejects(cancelExecutionRPC(f.c,{...input,identity:{...input.identity,ownershipGeneration:2}}));
    const row=await cancelExecutionRPC(f.c,input);assert.equal(row.observation,'terminal-observed');assert.equal(f.interrupts,1);
    await assert.rejects(cancelExecutionRPC(f.c,input));
  });
  assert.equal(f.c.read().executions[0].stopReceipt,undefined);
});

test('B1.1 cancellation: stale generation after native await prevents interrupt; trusted stop proof fenced',async()=>{
  const f=fixture();f.ctx.session.get=async()=>{f.c.mutate(s=>{s.tasks[0].ownershipGeneration++;return {};});return {id:'s1',projectID:'project',agent:'build',location:{directory:f.root},model:f.c.read().members[0].modelDefault};};
  await assert.rejects(requestCancellation(f.c,'e','race'),/STALE/);assert.equal(f.interrupts,0);
  const g=fixture();await assert.rejects(verifyExecutionStop(g.c,'e'),/NOT_PROVEN/);
  await assert.rejects(verifyExecutionStop(g.c,'e',{verifyStop:async()=>({stopped:true})}),/NOT_PROVEN/);
  const proof=async r=>({stopped:true,executionID:r.id,identity:r.identity,receiptID:'host-receipt'});
  assert.equal((await verifyExecutionStop(g.c,'e',{verifyStop:proof})).state,'stop-verified');
  const h=fixture();await assert.rejects(verifyExecutionStop(h.c,'e',{verifyStop:async r=>{h.c.mutate(s=>{s.tasks[0].workRevision++;return {};});return proof(r);}}),/STALE/);
});

function git(root,...args){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Test','-c','user.email=test@localhost','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function integrationFixture(conflict=false){
  const f=fixture();git(f.root,'init');writeFileSync(join(f.root,'file.txt'),'base\n');git(f.root,'add','.');git(f.root,'commit','-m','base');
  const peer=join(f.home,'peer');git(f.root,'worktree','add','-b','peer-1',peer);writeFileSync(join(peer,'file.txt'),'peer\n');git(peer,'commit','-am','peer');
  if(conflict){writeFileSync(join(f.root,'file.txt'),'main\n');git(f.root,'commit','-am','main');}
  const directory=join(f.home,'.repo-integrations','merge');mkdirSync(join(f.home,'.repo-integrations'));
  f.c.mutate(s=>{s.members[0].branch='peer-1';s.members[0].directory=peer;
    for(const m of s.members.slice(0,2)){
      const r=reportBody({taskID:'t',text:'reviewed',files:['file.txt'],commands:[{command:'check',exitCode:0,output:'pass'}],status:'completed',diff:'file changed',remaining:''},s,m);writeReport(f.c.directory,r);s.artifacts??=[];s.artifacts.push(r);
      if(m.id==='peer-1')s.tasks[0].submission=r.id;else s.tasks[0].review.reportID=r.id;
    }return {};});
  return {...f,input:{requestID:'merge',taskID:'t',taskVersion:3,ownershipGeneration:1,workRevision:1,baseCommit:git(f.root,'rev-parse','HEAD'),sourceCommit:git(peer,'rev-parse','HEAD'),directory}};
}
const authority={authorize:async()=>true,verifyReview:async()=>true};
test('B1.1 integration: actual isolated merge, durable receipt, protocol gate and reopen idempotency',async()=>{
  const f=integrationFixture(),s=f.c.read(),payload={requestID:'integrate',planID:'p',planVersion:1,projectID:'project',teamID:'team',canonicalRoot:f.root,taskID:'t',taskVersion:3,ownershipGeneration:1};
  assert.throws(()=>protocolAction(s,'peer-2','integrate',payload,{root:f.root,projectID:'project',teamID:'team'},{verifyReport:()=>true}),/MERGE_NOT_PROVEN/);
  const row=await integrateReviewedTask(f.c,f.input,authority);assert.equal(row.state,'merged');assert.equal(git(f.root,'rev-parse','HEAD'),f.input.baseCommit);assert.equal(readFileSync(join(f.input.directory,'file.txt'),'utf8'),'peer\n');
  assert.deepEqual(await integrateReviewedTask(new OfficialCoordinator(f.ctx),f.input,authority),row);
  const current=f.c.read();assert.equal(protocolAction(current,'peer-2','integrate',payload,{root:f.root,projectID:'project',teamID:'team'},{verifyReport:()=>true}).status,'INTEGRATED');
  await assert.rejects(integrateReviewedTask(f.c,{...f.input,sourceCommit:f.input.baseCommit},authority),/IDEMPOTENCY/);
});
test('B1.1 integration: conflict quarantined, no retry; auth/stale review/workspace rejected',async()=>{
  const f=integrationFixture(true);await assert.rejects(integrateReviewedTask(f.c,f.input),/NOT_AUTHORIZED/);
  await assert.rejects(integrateReviewedTask(f.c,{...f.input,directory:join(f.home,'unsafe')},authority),/WORKSPACE_INVALID/);
  const row=await integrateReviewedTask(f.c,f.input,authority);assert.equal(row.state,'conflict');assert.match(row.conflicts,/file.txt/);assert.deepEqual(await integrateReviewedTask(f.c,f.input,authority),row);
  const g=integrationFixture();g.c.mutate(s=>{s.tasks[0].workRevision++;return {};});await assert.rejects(integrateReviewedTask(g.c,g.input,authority),/STALE_REVIEW/);
});
test('B1.1 integration: exact commit review binding and managed evidence mandatory; uncertainty not retried',async()=>{
  const f=integrationFixture();await assert.rejects(integrateReviewedTask(f.c,f.input,{authorize:async()=>true}),/REVIEW_BINDING_NOT_PROVEN/);
  f.c.mutate(s=>{s.integrations=[{id:'reserved',requestID:f.input.requestID,taskID:'t',input:f.input,state:'preparing'}];return {};});
  assert.equal((await integrateReviewedTask(f.c,f.input,authority)).state,'preparing');
  const g=integrationFixture();g.c.mutate(s=>{s.artifacts[0].workRevision++;return {};});await assert.rejects(integrateReviewedTask(g.c,g.input,authority),/REPORT_INVALID/);
});
test('B1.1 engine selector: canonical or read-only only; every live flag blocked',()=>{
  assert.equal(selectEngine(), 'legacy-read-only');assert.equal(selectEngine({officialPilot:true}), 'canonical');
  for(const options of [{nativeDispatch:true},{pilotWake:true},{officialPilot:true,nativeDispatch:true}])assert.throws(()=>selectEngine(options),/BLOCKED/);
  const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');assert.ok(source.indexOf("throw Error('PEER_ENGINE_SELECTION_INVALID')")<source.indexOf('await registerDiagnostics(ctx)'));
  const readOnly=source.slice(source.indexOf("if(engine==='legacy-read-only')"),source.indexOf("if(engine==='canonical')"));assert.doesNotMatch(readOnly,/new OfficialCoordinator|registerOfficialCoordinator|bootstrap|interrupt/);
});
