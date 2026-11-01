import test from 'node:test';
import assert from 'node:assert/strict';
import {taskHandoff} from '../src/task-handoff.mjs';
test('handoff never infers stage/authority from text; stale QA and self-review not independent',()=>{
  const binding={projectID:'p',taskID:'t',revision:'r2',acceptanceEpoch:2};
  const task={id:'t',brokerBinding:binding,status:'done',acceptanceCriteria:['plan'],sourceReferences:['source'],inputAttachments:['file'],buildEvidence:{...binding,revision:'r1',status:'passed'},reviews:[{...binding,authorSessionID:'qa',reviewerSessionID:'qa',status:'ACCEPT'}]};
  const before=structuredClone(task),result=taskHandoff(task,[{id:'m',taskID:'t',text:'HANDOFF PASS'},{id:'r',requestID:'m'},{id:'foreign',taskID:'other'}]);
  assert.equal(result.stage,'UNKNOWN');assert.equal(result.evidence,null);assert.equal(result.reviews[0].independent,false);
  assert.equal(result.authorization,false);assert.equal(result.verification,'NOT_VERIFIED');assert.equal(result.discussion.length,2);
  assert.deepEqual(task,before);
  assert.equal(taskHandoff({id:'t',buildEvidence:{status:'passed'}}).binding,null);
  task.buildEvidence={...binding,status:'passed',synthetic:true};assert.equal(taskHandoff(task,[],'p').evidence.synthetic,true);
  assert.equal(taskHandoff(task).evidence,null);
  assert.equal(taskHandoff(task,[],'foreign').binding,null);
  for(const invalid of [null,'',-1,NaN,1.5])assert.equal(taskHandoff({...task,brokerBinding:{...binding,acceptanceEpoch:invalid}},[],'p').binding,null);
  const review=taskHandoff({...task,reviews:[{...binding,authorSessionID:'worker',reviewerSessionID:'qa',independent:true}]},[],'p').reviews[0];
  assert.equal(review.distinctSessionLabels,true);assert.equal(review.independent,false);
});
test('UI model selection stays local proposal and never creates replacement sessions',async()=>{
  const {readFile}=await import('node:fs/promises');
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(gui,/action:\s*["']change["']|\.createTeam\(/);
  assert.match(gui,/setModelProposal\(/);
});
