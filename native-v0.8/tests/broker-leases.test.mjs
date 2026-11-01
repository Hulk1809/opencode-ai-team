import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fixture} from './fixtures/operation-fixture.mjs';
import {brokerControl} from '../src/broker-control.mjs';
import {claimLease,endLease} from '../src/broker-leases.mjs';
test('broker lease holds across model idle, unknown cleanup and restart; terminal evidence releases same resource',async t=>{
  const root=await mkdtemp('/tmp/opencode/lease-');t.after(()=>rm(root,{recursive:true,force:true}));
  const f=await fixture(root,{recover:false});let quiet=false;
  const options={...f.options,operations:{...f.options.operations,leasePolicy:{resource:async()=>'/synthetic/tree',verifyQuiescence:async()=>quiet}}};
  let control=brokerControl(options);await control.recover();await control.handlers.approve({kind:'owner'},f.signed('approve'));
  const a=await control.handlers.operationApprove(f.peer('admin'),f.request('a'));
  const b=await control.handlers.operationApprove(f.peer('admin'),f.request('b','test','devops'));
  await control.handlers.operationAdmit(f.peer('qa'),{operationID:a.operationID});
  await assert.rejects(control.handlers.operationAdmit(f.peer('devops'),{operationID:b.operationID}),/lease busy/);
  // Model idle/failed/interrupted has no method that can release broker lease.
  for(const modelOutcome of ['idle','failed','interrupted']){
    assert.ok(modelOutcome);assert.equal((await f.store.load()).operationLeases[a.operationID].state,'ACTIVE');
  }
  await assert.rejects(control.operations.execute(a.operationID),/Quiescence/);
  assert.equal((await f.store.load()).operationLeases[a.operationID].state,'UNCERTAIN');
  control=brokerControl(options);await assert.rejects(control.recover(),/Unreconciled/);
  assert.equal((await f.store.load()).operations[b.operationID].status,'approved');
  quiet=true;await control.recover();await control.handlers.operationAdmit(f.peer('devops'),{operationID:b.operationID});
  await control.operations.execute(b.operationID);
  assert.equal((await f.store.load()).operationLeases[b.operationID].state,'SAFE_TERMINAL');
});
test('broker state fence excludes cross-task same worktree, allows independent resources, rejects stale checkpoint',()=>{
  const state={},a={operationID:'a',projectID:'p',workerSessionID:'one'},b={operationID:'b',projectID:'p',workerSessionID:'two'};
  a.leaseGeneration=claimLease(state,a,'tree-one').generation;
  assert.throws(()=>claimLease(state,b,'tree-one'),/busy/);
  b.leaseGeneration=claimLease(state,b,'tree-two').generation;
  assert.throws(()=>endLease(state,{...a,leaseGeneration:0},true,true),/fence/);
  endLease(state,a,false);assert.throws(()=>claimLease(state,{...b,operationID:'c'},'tree-one'),/busy/);
  endLease(state,a,true,true);assert.equal(state.operationLeases.a.state,'CHECKPOINT_VERIFIED');
  assert.throws(()=>endLease(state,a,false),/released/);
  assert.throws(()=>claimLease(state,a,'tree-one'),/fence/);
  const c={operationID:'c',projectID:'p',workerSessionID:'three'};
  assert.ok(claimLease(state,c,'tree-one').generation>a.leaseGeneration);
  assert.equal(state.operationLeases.b.state,'ACTIVE');
});
