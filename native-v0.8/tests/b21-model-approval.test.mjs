import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {reviewPlan} from '../src/peer-approvals.mjs';
import {readFileSync} from 'node:fs';

test('B2.1 model button distinguishes native persistence from verified current composer',()=>{
  const source=readFileSync(new URL('../src/pilot-routing.tsx',import.meta.url),'utf8');
  assert.ok(source.includes('await selectCurrentComposer(ctx,readback,member,observed,catalog())'));
  assert.ok(source.includes('PENDING composer verification'));
  assert.ok(source.includes('ctx.sessions.current()?.id===member.sessionID'));
});

test('B2.1 direct model UX fails closed without trusted host Owner context, no confirmation fallback',()=>{
  const main=readFileSync(new URL('../src/pilot-owner-main.ts',import.meta.url),'utf8');
  const guard=main.indexOf("if(publication?.operation==='selectModel')throw Error(OWNER_MODEL_CONTEXT_BLOCKED)");
  assert.ok(guard>0&&guard<main.indexOf('dialog.showMessageBox'));
  const ui=readFileSync(new URL('../src/pilot-routing.tsx',import.meta.url),'utf8');
  assert.ok(ui.includes('disabled title={OWNER_MODEL_CONTEXT_BLOCKED}'));
  assert.ok(!ui.includes('Lưu model native · Owner xác nhận'));
});

test('B2.1 model persistence validates binding, stale selection, activity and durable readback',async()=>{
  let state={generation:'g',teamID:'t',projectID:'p',status:'ready',tasks:[],members:[{id:'peer-1',sessionID:'s',directory:'/repo',agent:'build'}]},busy=false,calls=0;
  let session={id:'s',projectID:'p',agent:'build',location:{directory:'/repo'},model:{providerID:'test',id:'old',variant:'default'}};
  const c=Object.create(OfficialCoordinator.prototype);c.read=()=>structuredClone(state);c.mutate=f=>{const next=structuredClone(state),r=f(next);state=next;return r.value};
  c.ctx={model:{list:async()=>[{providerID:'test',id:'new',enabled:true,variants:[{id:'default'}]}]},session:{get:async()=>structuredClone(session),active:async()=>busy?{s:{type:'running'}}:{},switchModel:async({model})=>{calls++;session.model=model}}};
  const input={operation:'selectModel',requestID:'r',generation:'g',teamID:'t',sessionID:'s',expectedModel:session.model,model:{providerID:'test',id:'new',variant:'default'}};
   busy=true;assert.equal((await c.selectModel(input)).status,'QUEUED');assert.equal(calls,0);assert.equal(session.model.id,'old');assert.equal(state.members[0].queuedModel.desired.id,'new');busy=false;
   state.tasks=[{assignee:'peer-1',executionState:'outstanding'}];
   busy=true;assert.equal((await c.selectModel(input)).status,'QUEUED');assert.equal(calls,0);busy=false;
   state.tasks=[{assignee:'peer-1',executionState:'outstanding'}];
  await assert.rejects(c.selectModel({...input,generation:'stale'}),/INVALID/);
  await assert.rejects(c.selectModel({...input,teamID:'other'}),/BINDING/);
  await assert.rejects(c.selectModel({...input,model:{providerID:'test',id:'missing'}}),/UNAVAILABLE/);
   assert.equal((await c.selectModel(input)).status,'APPLIED');assert.equal(calls,1);
   assert.equal(state.tasks[0].executionState,'outstanding');
   assert.equal(state.members[0].queuedModel,undefined);
  await assert.rejects(c.selectModel(input),/STALE/);assert.equal(calls,1);
});

test('B2.1 Owner can review initial plan without synthetic risk; settled revision immutable',()=>{
  const s={plans:[{planID:'p',version:1,digest:'d',needsOwner:false}],tasks:[]};
  const i={requestID:'r',planID:'p',expectedVersion:1,digest:'d',decision:'approve'};
  assert.equal(reviewPlan(s,i).executionAuthorized,false);
  assert.equal(reviewPlan(s,i).id,s.approvals[0].id);
  assert.throws(()=>reviewPlan(s,{...i,requestID:'r2',decision:'reject'}),/NOT_REQUIRED/);
  assert.throws(()=>reviewPlan(s,{...i,requestID:'r3',digest:'old'}),/STALE/);
});

test('model recovery rejects unknown activity and retries provider failure without releasing task',async()=>{
  let state={generation:'g',teamID:'t',projectID:'p',status:'ready',tasks:[{id:'b',assignee:'peer-1',executionState:'outstanding'}],members:[{id:'peer-1',sessionID:'s',directory:'/repo',agent:'build'}]};
  let session={id:'s',projectID:'p',agent:'build',location:{directory:'/repo'},model:{providerID:'test',id:'old',variant:'default'}},activity=null,calls=0,quota=true;
  const c=Object.create(OfficialCoordinator.prototype);
  c.read=()=>structuredClone(state);c.mutate=f=>{const next=structuredClone(state),r=f(next);state=next;return r.value};
  c.ctx={model:{list:async()=>[{providerID:'test',id:'new',enabled:true,variants:[{id:'default'}]}]},session:{get:async()=>structuredClone(session),active:async()=>activity,switchModel:async({model})=>{calls++;if(quota)throw Error('429 quota exhausted');session.model=model}}};
  const input={operation:'selectModel',requestID:'r',generation:'g',teamID:'t',sessionID:'s',expectedModel:session.model,model:{providerID:'test',id:'new',variant:'default'}};
  for(const invalid of [null,undefined,[],false]){
    activity=invalid;await assert.rejects(c.selectModel(input),/MODEL_SESSION_ACTIVITY_UNKNOWN/);
  }
  assert.equal(calls,0);assert.equal(state.members[0].modelPreference,undefined);
  activity={s:null};assert.equal((await c.selectModel(input)).status,'QUEUED');assert.equal(calls,0);
  activity={};await assert.rejects(c.selectModel(input),/429 quota exhausted/);
  assert.equal(state.members[0].modelPreference.status,'BLOCKED');assert.equal(session.model.id,'old');
  quota=false;assert.equal((await c.selectModel({...input,requestID:'retry'})).status,'APPLIED');
  assert.equal(calls,2);assert.equal(state.tasks[0].executionState,'outstanding');assert.equal(state.members[0].queuedModel,undefined);
});
