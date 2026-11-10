import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {ingestPlan,protocolAction} from '../src/peer-protocol.mjs';
import {taskReadiness,readyTasks} from '../src/peer-readiness.mjs';
import {executionIdentity,observeExecution,requestCancellation,verifyNativeBinding} from '../src/peer-native.mjs';

function setup(){
  const root=mkdtempSync('/tmp/opencode/unified-'),projectID='project',teamID='team';
  const members=Array.from({length:4},(_,i)=>({id:`peer-${i+1}`,role:`peer-${i+1}`,sessionID:`s${i}`,directory:root,agent:'build',modelDefault:{providerID:'fixture',id:`model-${i}`,variant:'default'}}));
  let interrupts=0,active={},fail=false;
  const sessions=Object.fromEntries(members.map(m=>[m.sessionID,{id:m.sessionID,projectID,agent:'build',location:{directory:root},model:m.modelDefault,outcome:'succeeded'}]));
  const ctx={location:{directory:root,project:{canonical:root,id:projectID}},options:{pilotStore:join(root,'store')},session:{get:async({sessionID})=>{if(fail)throw Error('offline');return sessions[sessionID];},active:async()=>active,interrupt:async()=>{interrupts++;if(fail)throw Error('uncertain');}}};
  const c=new OfficialCoordinator(ctx);c.mutate(()=>({state:{mode:'peer',status:'ready',canonicalRoot:root,projectID,teamID,members,tasks:[],messages:[]}}));
  return {root,ctx,c,members,sessions,get interrupts(){return interrupts;},set active(v){active=v;},set fail(v){fail=v;},host:i=>({sessionID:members[i].sessionID,agent:'build'})};
}

test('Ensemble ADAPT: per-recipient durable receipts survive reopen; no dispatch or false admission',async()=>{
  const f=setup(),message=await f.c.ownerSend({recipient:'team',text:'Shared plan',requestID:'broadcast'});
  for(let i=0;i<4;i++){
    const before=await f.c.execute('inbox',{},f.host(i));assert.equal(before.messages[0].receipt,null);
    const input={messageID:message.id,requestID:`ack-${i}`};
    const receipt=await f.c.execute('receipt',input,f.host(i));assert.equal(receipt.state,'acknowledged');assert.equal(receipt.sessionID,f.members[i].sessionID);
    assert.deepEqual(await f.c.execute('receipt',input,f.host(i)),receipt);
  }
  assert.equal(new OfficialCoordinator(f.ctx).read().receipts.length,4);assert.equal(f.interrupts,0);
  const direct=await f.c.ownerSend({recipient:'peer-1',text:'private',requestID:'direct'});
  await assert.rejects(f.c.execute('receipt',{messageID:direct.id,requestID:'foreign'},f.host(1)),/FORBIDDEN/);
  await assert.rejects(f.c.execute('receipt',{messageID:direct.id,requestID:'ack-0'},f.host(0)),/IDEMPOTENCY/);
  await assert.rejects(f.c.wake(message),/DISPATCH_DISABLED/);
});

test('Noriq ADAPT: Owner review bound to immutable plan digest; approval never authorizes execution',async()=>{
  const f=setup();let p=await f.c.ownerPlan({requestID:'plan',expectedVersion:0,markdown:'# PLAN.md',approvedScopeRef:'scope',acceptanceCriteria:['tests']});
  const payload=x=>({requestID:'risk',planID:p.planID,planVersion:1,projectID:'project',teamID:'team',canonicalRoot:f.root,...x});
  await f.c.protocol('discuss',payload({round:1,text:'Need Owner scope review',risk:'approval'}),f.host(0));
  const review={requestID:'review',planID:p.planID,expectedVersion:1,digest:p.digest,decision:'approve'};
  await assert.rejects(f.c.ownerPlan({...review,digest:'wrong'}),/STALE/);
  const receipt=await f.c.ownerPlan(review);assert.equal(receipt.executionAuthorized,false);assert.equal(f.c.read().plans[0].needsOwner,false);
  assert.deepEqual(await f.c.ownerPlan(review),receipt);
  await assert.rejects(f.c.ownerPlan({...review,decision:'reject'}),/IDEMPOTENCY/);
  await assert.rejects(f.c.protocol('approve',payload({}),f.host(0)),/ACTION/);
  assert.equal(new OfficialCoordinator(f.ctx).read().approvals.length,1);
  assert.equal(f.c.read().plans[0].digest,p.digest);
});

test('Beads ADAPT: shared ready predicate gates both list and atomic claim; transitive dependencies',()=>{
  const f=setup(),state=f.c.read(),ctx={root:f.root,projectID:'project',teamID:'team'};
  const p=ingestPlan(state,{requestID:'p',expectedVersion:0,text:'Plan',approvedScopeRef:'scope',acceptanceCriteria:['pass']},ctx);
  let seq=0;const call=(action,extra)=>protocolAction(state,'peer-1',action,{requestID:`r${++seq}`,planID:p.planID,planVersion:1,projectID:'project',teamID:'team',canonicalRoot:f.root,...extra},ctx);
  const propose=dependencies=>call('propose',{text:'work',dependencies,files:[],requiredCapabilities:[],acceptanceCriteria:['pass'],requiredChecks:['check']});
  const a=propose([]),b=propose([a.id]),d=propose([b.id]);p.discussionClosed=true;
  for(const t of [a,b,d])call('ready',{taskID:t.id,taskVersion:1,ownershipGeneration:0});
  assert.deepEqual(readyTasks(state).map(t=>t.id),[a.id]);
  assert.deepEqual(taskReadiness(state,state.tasks[1]).blockedBy,[a.id]);
  assert.throws(()=>call('claim',{taskID:b.id,taskVersion:2,ownershipGeneration:0}),/DEPENDENCIES/);
  const claim=call('claim',{taskID:a.id,taskVersion:2,ownershipGeneration:0});assert.equal(claim.ownershipGeneration,1);
  assert.throws(()=>call('claim',{taskID:a.id,taskVersion:2,ownershipGeneration:0}),/STALE_TASK/);
  assert.equal(readyTasks(state).length,0);
});

test('native adapter cancellation uncertain/terminal readback never frees outstanding task or retries interrupt',async()=>{
  const f=setup();f.c.mutate(state=>{
    const task={id:'task',planID:'p',planVersion:1,assignee:'peer-1',ownershipGeneration:1,workRevision:1,executionState:'outstanding',status:'RUNNING'};
    state.tasks.push(task);state.executions=[{id:'exec',taskID:task.id,sessionID:'s0',identity:executionIdentity(state,task),state:'uncertain'}];return {};
  });
  f.active={s0:{type:'running'}};
  assert.equal((await observeExecution(f.c,'exec')).observation,'running');
  f.active={};assert.equal((await requestCancellation(f.c,'exec','cancel')).observation,'terminal-observed');
  assert.equal(f.interrupts,1);await requestCancellation(new OfficialCoordinator(f.ctx),'exec','retry');assert.equal(f.interrupts,1);
  assert.equal(f.c.read().tasks[0].executionState,'outstanding');
  f.fail=true;assert.equal((await observeExecution(f.c,'exec')).observation,'unknown');
  f.c.mutate(state=>{state.tasks[0].ownershipGeneration++;return {};});
  await assert.rejects(observeExecution(f.c,'exec'),/STALE/);
  await assert.rejects(requestCancellation(f.c,'exec','stale'),/STALE/);
});

test('native binding rejects wrong session/project/model/workspace; independent peer models preserved',()=>{
  const f=setup(),state=f.c.read(),m=state.members[0],s=f.sessions.s0;
  assert.equal(verifyNativeBinding(state,m,s),true);
  for(const patch of [{id:'other'},{projectID:'other'},{model:f.sessions.s1.model},{location:{directory:'/other'}},{location:{directory:f.root,workspaceID:'other'}}])assert.throws(()=>verifyNativeBinding(state,m,{...s,...patch}),/BINDING/);
  assert.equal(new Set(state.members.map(m=>m.modelDefault.id)).size,4);
});

test('Owner rejection freezes old plan operations; next accepted plan remains separate',async()=>{
  const f=setup(),p=await f.c.ownerPlan({requestID:'p',expectedVersion:0,text:'Plan',approvedScopeRef:'scope',acceptanceCriteria:['pass']});
  f.c.mutate(state=>{state.plans[0].needsOwner=true;return {};});
  await f.c.ownerPlan({requestID:'reject',planID:p.planID,expectedVersion:1,digest:p.digest,decision:'reject'});
  await assert.rejects(f.c.protocol('discuss',{requestID:'late',planID:p.planID,planVersion:1,projectID:'project',teamID:'team',canonicalRoot:f.root,round:1,text:'late',risk:'none'},f.host(0)),/REJECTED/);
  const next=await f.c.ownerPlan({requestID:'next',expectedVersion:1,planID:p.planID,text:'Revised',approvedScopeRef:'scope',acceptanceCriteria:['pass']});
  assert.equal(next.version,2);assert.equal(f.c.read().plans[0].ownerDecision,'reject');
});

test('interrupt failure persists uncertainty across restart and never retries or releases ownership',async()=>{
  const f=setup();let calls=0;f.ctx.session.interrupt=async()=>{calls++;throw Error('lost receipt');};
  f.c.mutate(state=>{const t={id:'t',planID:'p',planVersion:1,assignee:'peer-1',ownershipGeneration:1,workRevision:1,executionState:'outstanding'};state.tasks.push(t);state.executions=[{id:'e',taskID:'t',sessionID:'s0',identity:executionIdentity(state,t)}];return {};});
  await requestCancellation(f.c,'e','c');await requestCancellation(new OfficialCoordinator(f.ctx),'e','c');
  assert.equal(calls,1);assert.equal(f.c.read().executions[0].cancellation.state,'uncertain');assert.equal(f.c.read().tasks[0].executionState,'outstanding');
});
