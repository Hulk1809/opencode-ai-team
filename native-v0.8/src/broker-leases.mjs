// Internal broker state helpers. Caller MUST hold broker serialization + process fence.
// No storage, RPC, native dispatch or second authority here.
const live=r=>!['SAFE_TERMINAL','CHECKPOINT_VERIFIED'].includes(r.state);
export function claimLease(state,row,resource){
  if(typeof resource!=='string'||!resource||resource.length>1024)throw Error('Trusted resource identity required');
  state.operationLeases??={};
  const old=state.operationLeases[row.operationID];
  if(old){
    if(old.state!=='ACTIVE'||old.resource!==resource||old.projectID!==row.projectID||old.sessionID!==row.workerSessionID||old.generation!==row.leaseGeneration)throw Error('Lease fence mismatch');
    return old;
  }
  if(Object.values(state.operationLeases).some(r=>live(r)&&(r.resource===resource||r.sessionID===row.workerSessionID&&r.projectID===row.projectID)))throw Error('Session/resource lease busy');
  state.leaseGeneration=(state.leaseGeneration??0)+1;
  return state.operationLeases[row.operationID]={operationID:row.operationID,projectID:row.projectID,sessionID:row.workerSessionID,resource,generation:state.leaseGeneration,state:'ACTIVE'};
}
export function endLease(state,row,verified,checkpoint=false){
  const lease=state.operationLeases?.[row.operationID];
  if(!lease||lease.generation!==row.leaseGeneration)throw Error('Lease fence mismatch');
  if(!live(lease))throw Error('Lease already released');
  lease.state=verified===true?(checkpoint?'CHECKPOINT_VERIFIED':'SAFE_TERMINAL'):'UNCERTAIN';
}
