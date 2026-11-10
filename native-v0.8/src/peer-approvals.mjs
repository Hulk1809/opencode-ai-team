import {createHash,randomUUID} from 'node:crypto';

// ADAPT: Noriq proposed-plan human gate. Called only behind existing Owner grant bridge.
export function reviewPlan(state,input){
  if(!input||Object.keys(input).some(k=>!['requestID','planID','expectedVersion','digest','decision'].includes(k))||typeof input.requestID!=='string'||!input.requestID.trim()||input.requestID.length>160||!['approve','reject'].includes(input.decision))throw Error('PLAN_REVIEW_INVALID');
  const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  state.approvals??=[];
  const old=state.approvals.find(a=>a.requestID===input.requestID);
  if(old){if(old.requestHash!==hash)throw Error('PLAN_REVIEW_IDEMPOTENCY_CONFLICT');return old;}
  const plan=state.plans?.at(-1);
  if(!plan||plan.planID!==input.planID||plan.version!==input.expectedVersion||plan.digest!==input.digest)throw Error('PLAN_REVIEW_STALE');
   if(plan.ownerDecision)throw Error('PLAN_REVIEW_NOT_REQUIRED');
  const receipt={id:randomUUID(),requestID:input.requestID,requestHash:hash,planID:plan.planID,planVersion:plan.version,digest:plan.digest,decision:input.decision,authority:'owner-bridge',executionAuthorized:false,at:new Date().toISOString()};
  state.approvals.push(receipt);
  plan.ownerDecision=input.decision;
  if(input.decision==='approve')plan.needsOwner=false;
  else{
    if(state.executionPolicy&&!state.executionPolicy.revokedAt){state.executionPolicy.revokedAt=Date.now();state.executionPolicy.revokedReason='PLAN_REJECTED';}
    for(const task of state.tasks.filter(t=>t.planID===plan.planID&&t.planVersion===plan.version&&t.executionState==='not-started')){task.status='CANCELLED';task.taskVersion++;task.ownershipGeneration++;}
  }
  return receipt;
}
