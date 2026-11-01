import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCompletionEvidence,invalidateEvidence} from '../src/evidence.mjs';
function fixture(){
  const common={taskID:'t',revision:'rev',beforeRevision:'rev',exitCode:0,status:'passed',acceptanceEpoch:0};
  return {id:'t',acceptanceEpoch:0,assignee:'backend',outputAttachments:['artifact'],buildEvidence:{...common,id:'build',sessionID:'worker'},qaEvidence:{...common,id:'qa',buildID:'build',sessionID:'qa-worker'},reviews:[{from:'qa',revision:'rev',buildID:'build',qaID:'qa',acceptanceEpoch:0}]};
}
test('completion requires independent QA, matching revision/epoch, artifact and Admin',()=>{
  assert.doesNotThrow(()=>assertCompletionEvidence(fixture(),'rev','admin'));
  for(const change of [
    t=>{t.buildEvidence.exitCode=1;},t=>{t.qaEvidence.sessionID='worker';},t=>{t.qaEvidence.buildID='old';},
    t=>{t.reviews[0].revision='old';},t=>{t.outputAttachments=[];},t=>{t.acceptanceEpoch=1;},
    t=>{t.buildEvidence.taskID='another-task';},t=>{t.qaEvidence.exitCode=1;},
  ]){const task=fixture();change(task);assert.throws(()=>assertCompletionEvidence(task,'rev','admin'));}
  assert.throws(()=>assertCompletionEvidence(fixture(),'rev','backend'),/Owner\/Admin/);
});
test('source change marks all mismatched evidence stale; restoring old bytes does not revive PASS',()=>{
  const task=fixture();invalidateEvidence(task,'new-rev');
  for(const evidence of [task.buildEvidence,task.qaEvidence,...task.reviews])assert.equal(evidence.stale,true);
  assert.throws(()=>assertCompletionEvidence(task,'rev','admin'),/stale/);
});
test('reopen invalidates acceptance epoch even with unchanged source and preserves old evidence',()=>{
  const task=fixture();task.completionRevision=1;task.acceptanceEpoch++;
  invalidateEvidence(task,'rev');assert.equal(task.buildEvidence.staleReason,'task_reopened');
  assert.throws(()=>assertCompletionEvidence(task,'rev','admin'));
  assert.equal(task.completionRevision,1);assert.equal(task.buildEvidence.id,'build');
});
