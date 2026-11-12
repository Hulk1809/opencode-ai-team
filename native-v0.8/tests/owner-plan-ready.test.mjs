import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewPlan} from '../src/peer-approvals.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';

test('legacy approved plan closes discussion only with matching Owner operation',async()=>{
  const state={plans:[{planID:'p',version:1,digest:'hash',ownerDecision:'approve',discussionClosed:false}],tasks:[]};
  const c=Object.create(OfficialCoordinator.prototype);c.mutate=fn=>fn(state).value;
  const input={operation:'closeDiscussion',requestID:'close',planID:'p',planVersion:1,digest:'hash'};
  await assert.rejects(()=>c.ownerPlan({...input,digest:'stale'}),/STALE/);
  assert.equal(state.plans[0].discussionClosed,false);
  assert.equal((await c.ownerPlan(input)).executionAuthorized,false);
  await c.ownerPlan(input);assert.equal(state.discussionClosures.length,1);assert.equal(state.plans[0].discussionClosed,true);
});

test('Owner approval closes discussion without changing task versions or granting execution',()=>{
  const plan={planID:'p',version:1,digest:'digest',needsOwner:true,discussionClosed:false};
  const state={plans:[plan],tasks:[{protocolVersion:1,planID:'p',planVersion:1,status:'DRAFT',taskVersion:1},{protocolVersion:1,planID:'p',planVersion:0,status:'DRAFT',taskVersion:1},{protocolVersion:1,planID:'p',planVersion:1,status:'RUNNING',taskVersion:3}]};
  const input={requestID:'approve',planID:'p',expectedVersion:1,digest:'digest',decision:'approve'};
  const receipt=reviewPlan(state,input);
  assert.equal(plan.discussionClosed,true);assert.equal(plan.needsOwner,false);
  assert.deepEqual(state.tasks.map(t=>[t.status,t.taskVersion]),[['DRAFT',1],['DRAFT',1],['RUNNING',3]]);
  assert.equal(receipt.executionAuthorized,false);assert.equal(state.executionPolicy,undefined);
  assert.equal(reviewPlan(state,input).id,receipt.id);assert.equal(state.tasks[0].taskVersion,1);
});
