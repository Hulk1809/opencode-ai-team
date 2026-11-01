import {brokerControl} from './broker-control.mjs';
import {executeFixed} from './broker-executor.mjs';
import {createSnapshot,verifySnapshot} from './build-snapshot.mjs';
import {digest} from './broker.mjs';
import {brokerArtifacts} from './broker-artifacts.mjs';
import {join} from 'node:path';
import {protectedSnapshots} from './protected-snapshots.mjs';

// Internal composition only. No public activation flag or request-supplied host paths.
// Protected service still uses diagnostic mode until installation/security acceptance.
export async function brokerRuntime({ledger,ownerPublicKey,store,jobs,snapshotRoot,runRoot,cache,uid,gid,expiryMs=1000,operations}){
  if(!Number.isInteger(expiryMs)||expiryMs<10||expiryMs>60000)throw Error('Invalid expiry interval');
  await jobs.recover();
  const recovered=await jobs.load();
  if(recovered.jobs.some(j=>['queued','running','uncertain','timeout'].includes(j.state)&&!j.cleanedAt))throw Error('Unreconciled jobs block runtime admission');
  let execution=Promise.resolve(),closed=false;
  const artifacts=brokerArtifacts(join(snapshotRoot,'artifacts'));
  const snapshots=operations?.sourceWriter?protectedSnapshots({artifacts,...operations.sourceWriter}):null;
  if(snapshots)operations={...operations,protectedSource:true,describeSnapshot:snapshots.describeSnapshot,writeProposal:snapshots.proposal};
  const control=brokerControl({ledger,ownerPublicKey,...store,operations,verifyArtifact:artifacts.verify,
    execute:row=>{
      const result=execution.then(async()=>{
        if(closed)throw Error('Runtime closed');
        const manifestBytes=Buffer.from(row.manifest);
        ledger.authorize(row.projectID,row.scopeID,digest(manifestBytes),row.input.epoch);
        const snapshot=await createSnapshot(snapshotRoot,row.input.files);
        await verifySnapshot(snapshot);
        return executeFixed({ledger,jobs,manifestBytes,projectID:row.projectID,scopeID:row.scopeID,epoch:row.input.epoch,sessionID:row.sessionID,taskID:row.input.taskID,goal:row.input.goal,buildID:row.input.buildID,snapshot,cache,uid,gid,runRoot,artifacts});
      });
      execution=result.catch(()=>{});return result;
    },
    stopScope:async(projectID,scopeID)=>{
      const id=digest(JSON.stringify([projectID,scopeID]));
      await jobs.revoke(id);
      const state=await jobs.load();
      if(state.jobs.some(j=>j.scopeID===id&&j.state!=='queued'&&j.state!=='revoked'&&!j.cleanedAt))throw Error('Scope stop unverified');
      if(state.jobs.some(j=>j.scopeID===id&&j.containerID&&!j.cleanedAt))throw Error('Container stop unverified');
    },
  });
  await control.recover();
  let ticking=false,lastError=null;
  const timer=setInterval(()=>{
    if(ticking||closed)return;ticking=true;
    void control.expire().then(()=>{lastError=null;},()=>{lastError='Expiry stop unverified';}).finally(()=>{ticking=false;});
  },expiryMs);
  timer.unref();
  return {...control,snapshots,handlers:{...control.handlers,submit:(...args)=>closed?Promise.reject(Error('Runtime closed')):control.handlers.submit(...args)},health:()=>({expiryError:lastError}),close:async()=>{
      closed=true;clearInterval(timer);
    let timeout;
    try{await Promise.race([(async()=>{await control.operations?.close();await control.shutdown();await control.idle();await execution;})(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Shutdown unverified; reconciliation required')),20000);})]);}
    finally{clearTimeout(timeout);}
  }};
}
