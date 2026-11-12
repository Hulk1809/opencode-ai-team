import {randomUUID} from 'node:crypto';
import {sameModel} from './model-routing.mjs';

// ADAPT: Ensemble V2 session readback/interrupt. No prompt, retry, permission mutation or auto-reclaim.
export function verifyNativeBinding(state,member,session){
  if(session?.id!==member.sessionID||session.projectID!==state.projectID||session.agent!==member.agent||session.location?.directory!==member.directory||session.location?.workspaceID!==member.workspaceID||!sameModel(session.model,member.modelDefault))throw Error('PEER_NATIVE_BINDING_MISMATCH');
  return true;
}
export function executionIdentity(state,task){
  if(!task)throw Error('PEER_EXECUTION_STALE');
  return {projectID:state.projectID,teamID:state.teamID,planID:task.planID,planVersion:task.planVersion,taskID:task.id,ownershipGeneration:task.ownershipGeneration,workRevision:task.workRevision,sessionID:state.members.find(m=>m.id===task.assignee)?.sessionID};
}
function hasContextActiveWork(rows){
  if(!Array.isArray(rows))return false;
  return rows.some(r=>(r?.type==='shell'&&r.status==='running')||(r?.type==='compaction'&&r.status==='running')||(r?.type==='assistant'&&Array.isArray(r.content)&&r.content.some(p=>p?.type==='tool'&&['streaming','running'].includes(p.state?.status))));
}
export async function sessionActivity(ctx,sessionID){
  if(typeof ctx.session.active==='function')return ctx.session.active();
  const rows=await ctx.session.context({sessionID});
  if(!Array.isArray(rows))throw Error('PEER_NATIVE_CONTEXT_INVALID');
  const last=rows.at(-1);
  // No active() in server plugin API. Unknown/queued context never proves idle.
  return {[sessionID]:hasContextActiveWork(rows)||last?.type!=='idle'};
}
export function hasVerifiedStop(state,task){
  if(!state||!task)return false;
  const id=JSON.stringify(executionIdentity(state,task));
  const rows=(state.executions??[]).filter(e=>e.taskID===task.id&&JSON.stringify(e.identity)===id);
  return rows.length>0&&rows.every(r=>r.state==='stop-verified'&&r.stopReceipt?.executionID===r.id&&typeof r.stopReceipt?.receiptID==='string'&&r.stopReceipt.receiptID.length>0&&JSON.stringify(r.stopReceipt.identity)===id);
}
export async function observeExecution(coordinator,executionID){
  const state=coordinator.read(),record=state.executions?.find(e=>e.id===executionID);
  if(!record)throw Error('PEER_EXECUTION_UNKNOWN');
  const task=state.tasks.find(t=>t.id===record.taskID),member=state.members.find(m=>m.sessionID===record.sessionID);
  if(!task||!member||JSON.stringify(executionIdentity(state,task))!==JSON.stringify(record.identity))throw Error('PEER_EXECUTION_STALE');
  let observation='unknown';
  try{
    const session=await coordinator.ctx.session.get({sessionID:member.sessionID});verifyNativeBinding(state,member,session);
    const active=await sessionActivity(coordinator.ctx,member.sessionID);
    const contextBusy=typeof coordinator.ctx.session.context==='function'&&hasContextActiveWork(await coordinator.ctx.session.context({sessionID:member.sessionID}));
    if(active[member.sessionID]||contextBusy)observation='running';
    // ponytail: terminal readback is observation only; no trusted provider stop contract yet.
    else if(['succeeded','failed','cancelled','interrupted'].includes(session.outcome))observation='terminal-observed';
  }catch{ /* UNKNOWN never means stopped or permission to retry. */ }
  return coordinator.mutate(current=>{
    const currentTask=current.tasks.find(t=>t.id===record.taskID),row=current.executions?.find(e=>e.id===executionID);
    if(!row||JSON.stringify(row.identity)!==JSON.stringify(record.identity)||JSON.stringify(executionIdentity(current,currentTask))!==JSON.stringify(record.identity))throw Error('PEER_EXECUTION_STALE');
    row.observation=observation;row.observedAt=new Date().toISOString();return {value:structuredClone(row)};
  });
}
export async function requestCancellation(coordinator,executionID,requestID,expectedIdentity){
  if(typeof requestID!=='string'||!requestID.trim()||requestID.length>160)throw Error('PEER_CANCEL_INVALID');
  const prepared=coordinator.mutate(state=>{
    const row=state.executions?.find(e=>e.id===executionID);
    if(!row)throw Error('PEER_EXECUTION_UNKNOWN');
    const task=state.tasks.find(t=>t.id===row.taskID);
    if(!task||row.sessionID!==row.identity?.sessionID||JSON.stringify(executionIdentity(state,task))!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
    if(expectedIdentity&&JSON.stringify(expectedIdentity)!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
    if(row.cancellation)return {value:null};
    row.state='cancelling';
    row.cancellation={id:randomUUID(),requestID,state:'requesting',identity:structuredClone(row.identity),requestedAt:new Date().toISOString()};return {value:structuredClone(row)};
  });
  if(!prepared)return observeExecution(coordinator,executionID);
  let status='uncertain';
  try{
    const state=coordinator.read(),member=state.members.find(m=>m.sessionID===prepared.sessionID);
    verifyNativeBinding(state,member,await coordinator.ctx.session.get({sessionID:prepared.sessionID}));
    const fresh=coordinator.read(),task=fresh.tasks.find(t=>t.id===prepared.taskID);
    const record=fresh.executions?.find(e=>e.id===executionID);
    if(record?.sessionID!==prepared.sessionID||JSON.stringify(record?.identity)!==JSON.stringify(prepared.identity)||JSON.stringify(executionIdentity(fresh,task))!==JSON.stringify(prepared.identity))throw Error('PEER_EXECUTION_STALE');
    await coordinator.ctx.session.interrupt({sessionID:prepared.sessionID});status='requested';
  }catch{ /* Persist uncertainty. Never retry interrupt automatically. */ }
  coordinator.mutate(state=>{const row=state.executions.find(e=>e.id===executionID);if(JSON.stringify(row.identity)!==JSON.stringify(prepared.identity)||JSON.stringify(executionIdentity(state,state.tasks.find(t=>t.id===prepared.taskID)))!==JSON.stringify(prepared.identity))throw Error('PEER_EXECUTION_STALE');row.cancellation.state=status;if(status==='uncertain')row.state='uncertain';return {};});
  return observeExecution(coordinator,executionID);
}

// Trusted adapter only, never session.outcome or RPC-supplied proof. Missing host contract stays blocked.
export async function verifyExecutionStop(coordinator,executionID,adapter){
  const state=coordinator.read(),row=state.executions?.find(e=>e.id===executionID);
  if(!row)throw Error('PEER_EXECUTION_UNKNOWN');
  const task=state.tasks.find(t=>t.id===row.taskID),member=state.members.find(m=>m.sessionID===row.sessionID);
  if(!task||!member||JSON.stringify(executionIdentity(state,task))!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
  if(typeof adapter?.verifyStop!=='function')throw Error('PEER_STOP_NOT_PROVEN');
  let session,active;
  try{
    session=await coordinator.ctx.session.get({sessionID:row.sessionID});verifyNativeBinding(state,member,session);
    active=await sessionActivity(coordinator.ctx,row.sessionID);
    const rows=typeof coordinator.ctx.session.context==='function'?await coordinator.ctx.session.context({sessionID:row.sessionID}):null;
    const contextBusy=hasContextActiveWork(rows);
    const unsubmitted=session.outcome==null&&Array.isArray(rows)&&row.submission&&row.submission.state!=='admitted'&&!rows.some(r=>r?.type==='user'&&r.id===row.submission.id);
    if(!active||typeof active!=='object'||Array.isArray(active)||active[row.sessionID]||contextBusy||(!['succeeded','failed','cancelled','interrupted'].includes(session.outcome)&&!unsubmitted))throw Error('PEER_STOP_NOT_PROVEN');
  }catch{throw Error('PEER_STOP_NOT_PROVEN');}
  const fresh=coordinator.read(),freshTask=fresh.tasks.find(t=>t.id===row.taskID),freshRow=fresh.executions?.find(e=>e.id===executionID);
  if(!freshRow||JSON.stringify(freshRow.identity)!==JSON.stringify(row.identity)||JSON.stringify(executionIdentity(fresh,freshTask))!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
  const proof=await adapter.verifyStop(structuredClone(row),{session,active});
  if(proof?.stopped!==true||proof.executionID!==row.id||JSON.stringify(proof.identity)!==JSON.stringify(row.identity)||typeof proof.receiptID!=='string'||!proof.receiptID.trim())throw Error('PEER_STOP_NOT_PROVEN');
  return coordinator.mutate(current=>{
    const record=current.executions.find(e=>e.id===executionID),currentTask=current.tasks.find(t=>t.id===row.taskID);
    if(JSON.stringify(record.identity)!==JSON.stringify(row.identity)||JSON.stringify(executionIdentity(current,currentTask))!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
    if(record.stopReceipt&&record.stopReceipt.receiptID!==proof.receiptID)throw Error('PEER_STOP_IDEMPOTENCY_CONFLICT');
    record.stopReceipt??={receiptID:proof.receiptID,executionID:row.id,identity:structuredClone(row.identity),sessionOutcome:session.outcome,at:new Date().toISOString()};
    record.state='stop-verified';record.observation='terminal-observed';currentTask.executionState='stopped';return {value:structuredClone(record)};
  });
}
