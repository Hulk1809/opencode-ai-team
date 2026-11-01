import {fixture} from './operation-fixture.mjs';
import {brokerControl} from '../../src/broker-control.mjs';
import {brokerArtifacts} from '../../src/broker-artifacts.mjs';
import {protectedSnapshots} from '../../src/protected-snapshots.mjs';
const [root,point]=process.argv.slice(2);
async function pause(stage){if(stage===point){process.send(stage);await new Promise(()=>{});}}
const f=await fixture(root,{recover:false,saveHook:async s=>{
  if(s.operationAudit?.at(-1)?.type==='succeeded'){const op=s.operations[s.operationAudit.at(-1).operationID];await pause(op.workerRole==='qa'?'qa':'revision');}
}});
const snapshots=protectedSnapshots({artifacts:brokerArtifacts(root+'/artifacts'),resolveBase:async()=>[],withSource:async(_,fn)=>fn(root+'/source'),checkpoint:pause});
const initial=await snapshots.capture({...f.snapshot,acceptanceEpoch:0,authorPrincipalID:'backend',allowPaths:['src']});
f.manifest.tasks[0].snapshotHash=initial.snapshotHash;
const verify=f.options.operations.verifyEvidence;
const control=brokerControl({...f.options,operations:{...f.options.operations,protectedSource:true,describeSnapshot:snapshots.describeSnapshot,writeProposal:snapshots.proposal,verifyEvidence:(r,v,s)=>verify(r,v,s==='source-qa'?'terminal':s)}});
await control.recover();await control.handlers.approve({kind:'owner'},f.signed('approve'));
const edit=await control.handlers.operationApprove(f.peer('admin'),{...f.request('edit','edit','backend'),snapshotHash:initial.snapshotHash});
const admitted=await control.handlers.operationAdmit(f.peer('backend'),{operationID:edit.operationID});
await control.handlers.operationProposal(f.peer('backend'),{operationID:edit.operationID,generation:admitted.writerGeneration,files:[{path:'src/main.txt',mode:'100644',base64:Buffer.from('candidate').toString('base64')}]});
f.adapter.execute=async r=>f.proof(r,'terminal',r.writerResult);
await control.operations.execute(edit.operationID);
if(point==='qa'){
  const task=(await f.store.load()).tasks['["synthetic","task"]'];
  const qa=await control.handlers.operationApprove(f.peer('admin'),{...f.request('qa'),snapshotHash:task.snapshotHash,revision:task.revision,acceptanceEpoch:1});
  await control.handlers.operationAdmit(f.peer('qa'),{operationID:qa.operationID});
  f.adapter.execute=async r=>{const s=await snapshots.describeSnapshot(r.snapshotHash);return f.proof(r,'terminal',{snapshotHash:r.snapshotHash,sourceHash:s.sourceHash,revision:r.revision,acceptanceEpoch:1,baseCommit:r.baseCommit,qaPrincipalID:'qa',checks:[{id:'synthetic',status:'pass',outputHash:'a'.repeat(64)}]});};
  await control.operations.execute(qa.operationID);
}
