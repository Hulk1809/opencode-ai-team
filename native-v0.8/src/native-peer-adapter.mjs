import {randomUUID} from 'node:crypto';
import {executionIdentity,verifyNativeBinding,requestCancellation,verifyExecutionStop,sessionActivity} from './peer-native.mjs';
import {sameModel} from './model-routing.mjs';
import {verifyHostOwnerPolicy} from './host-owner-bridge.mjs';

const fail=(code='PEER_NATIVE_ADMISSION_BLOCKED')=>{throw Error(code);};
const int=v=>Number.isSafeInteger(v)&&v>0;
function bound(state,id){
  const row=state?.executions?.find(e=>e.id===id),task=state?.tasks.find(t=>t.id===row?.taskID);
  const member=state?.members.find(m=>m.sessionID===row?.sessionID),plan=state?.plans?.at(-1);
  if(!row||!task||!member||JSON.stringify(executionIdentity(state,task))!==JSON.stringify(row.identity))throw Error('PEER_EXECUTION_STALE');
  return {row,task,member,plan};
}
const pending=e=>e.submission&&!e.result;
const terminal=['failed','interrupted','cancelled','succeeded'];

// Canonical policy lives in coordinator state, bound to exact plan digest. No writer ships in production:
// missing policy denies. Calls are reserved before prompt.
export function admission(state,task,member,plan){
  const p=state.executionPolicy;
  if(!p||!['planID','planVersion','digest','maxActive','maxAttemptsPerTask','maxCalls','usedCalls','timeoutMs','models'].every(k=>k in p)||![p.maxActive,p.maxAttemptsPerTask,p.maxCalls,p.timeoutMs].every(int)||!Number.isSafeInteger(p.usedCalls)||!Array.isArray(p.models))fail('PEER_NATIVE_POLICY_REQUIRED');
  if(p.revokedAt)fail('PEER_NATIVE_AUTHORIZATION_REVOKED');
  if(p.signature!==undefined)verifyHostOwnerPolicy(state,p);
  if(!plan||plan.ownerDecision!=='approve'||plan.needsOwner||p.planID!==plan.planID||p.planVersion!==plan.version||p.digest!==plan.digest)fail('PEER_NATIVE_PLAN_NOT_APPROVED');
  if(task.planID!==plan.planID||task.planVersion!==plan.version||task.assignee!==member.id)fail('PEER_NATIVE_SCOPE_DENIED');
  if(!member.modelDefault||!p.models.some(m=>sameModel(m,member.modelDefault)))fail('PEER_NATIVE_MODEL_NOT_APPROVED');
  const rows=state.executions??[];
  if(rows.filter(pending).length>=p.maxActive)fail('PEER_NATIVE_CONCURRENCY_LIMIT');
  if(rows.filter(e=>e.taskID===task.id&&e.submission).length>=p.maxAttemptsPerTask)fail('PEER_NATIVE_RETRY_CEILING');
  if(p.usedCalls>=p.maxCalls)fail('PEER_NATIVE_BUDGET_EXHAUSTED');
  return p;
}

// V2 session.prompt returns inbox admission, not generation completion.
// No renderer/RPC grant issuer; production stays blocked until a trusted authority is wired.
export class NativePeerAdapter {
  constructor(coordinator,{authorize=()=>fail()}={}){this.coordinator=coordinator;this.authorize=authorize;}
  // Reuse canonical lease/CAS reducer. This path cannot make its own claim or approval.
  async admit(input,context){
    const c=this.coordinator;
    const task=await c.protocol('start',input,context,{admit:({state,plan,task,actor})=>{
      admission(state,task,state.members.find(m=>m.id===actor),plan);
      return this.authorize({state,plan,task,phase:'start'})===true;
    }});
    const state=c.read(),identity=executionIdentity(state,task);
    const row=state.executions.findLast(e=>JSON.stringify(e.identity)===JSON.stringify(identity));
    if(!row)fail('PEER_EXECUTION_UNKNOWN');
    return row.id;
  }
  async start(input,context){return this.dispatch(await this.admit(input,context));}
  async dispatch(executionID){
    const c=this.coordinator,state=c.read(),{row,member}=bound(state,executionID);
    if(row.submission)return structuredClone(row);
    const session=await c.ctx.session.get({sessionID:member.sessionID});
    verifyNativeBinding(state,member,session);
    const active=await sessionActivity(c.ctx,member.sessionID);
    if(!active||typeof active!=='object'||Array.isArray(active)||active[member.sessionID])fail('PEER_NATIVE_SESSION_BUSY');
    const intent=c.mutate(current=>{
      const {row,task,member,plan}=bound(current,executionID);
      if(row.submission)return {value:null};
      if(row.cancellation||row.state!=='admitted-by-adapter'||task.status!=='RUNNING'||task.executionState!=='outstanding'||!task.lease||task.lease.expiresAt<=Date.now())fail();
      if(current.executions.some(e=>e.id!==row.id&&e.sessionID===row.sessionID&&pending(e)))fail('PEER_NATIVE_SESSION_BUSY');
      const policy=admission(current,task,member,plan);
      if(this.authorize({state:current,task,member,plan,execution:row,phase:'dispatch'})!==true)fail();
      const text=`Approved plan ${plan.planID} v${plan.version} (${plan.digest})\n${plan.content}\n\nTask ${task.id}: ${task.text}\nAcceptance criteria:\n${task.acceptanceCriteria.join('\n')}\nReport actual results through team tools. A message alone does not complete this task.`;
      policy.usedCalls++;
      row.submission={id:`msg_${randomUUID().replaceAll('-','')}`,state:'submitting',at:Date.now(),deadline:Date.now()+policy.timeoutMs,planDigest:plan.digest,model:member.modelDefault};
      return {value:{sessionID:row.sessionID,id:row.submission.id,text}};
    });
    if(!intent)return c.read().executions.find(e=>e.id===executionID);
    try{
      const receipt=await c.ctx.session.prompt({...intent,delivery:'queue'});
      if(receipt?.id!==intent.id)fail('PEER_NATIVE_RECEIPT_MISMATCH');
      c.mutate(state=>{const {row}=bound(state,executionID);row.submission.state='admitted';return {};});
    }catch(error){
      c.mutate(state=>{const {row}=bound(state,executionID);row.submission.state='uncertain';return {};});
      // Lost response can hide successful admission. Never retry this intent.
      throw error;
    }
    return c.read().executions.find(e=>e.id===executionID);
  }
  async reconcile(executionID,now=Date.now()){
    const c=this.coordinator,state=c.read(),{row,member,plan}=bound(state,executionID);
    if(!row.submission)fail('PEER_NATIVE_NOT_SUBMITTED');
    const session=await c.ctx.session.get({sessionID:member.sessionID});
    verifyNativeBinding(state,member,session);
    const rows=await c.ctx.session.context({sessionID:member.sessionID});
    if(!Array.isArray(rows))fail('PEER_NATIVE_CONTEXT_INVALID');
    const anchor=rows.findIndex(r=>r.type==='user'&&r.id===row.submission.id);
    let result=null,observation=row.submission.state==='admitted'?'queued':'unknown';
    if(anchor>=0){
      observation='running';
      const tail=rows.slice(anchor+1),end=tail.findIndex(r=>r.type==='idle');
      const previous=rows.slice(0,anchor).findLastIndex(r=>r.type==='idle');
      const merged=rows.slice(previous+1,anchor).some(r=>r.type==='user');
      if(!merged&&end>=0&&!tail.slice(0,end).some(r=>r.type==='user')){
        const assistants=tail.slice(0,end).filter(r=>r.type==='assistant'),last=tail[end];
        if(last.id&&terminal.includes(last.outcome)&&(last.outcome!=='succeeded'||assistants.length)){
          result={requestID:row.submission.id,terminalID:last.id,outcome:last.outcome,assistantIDs:assistants.map(r=>r.id),
            ...(last.error?{error:String(last.error.type??last.error.message??'provider-error')}:{})};
          observation=last.outcome==='succeeded'?'completed':last.outcome;
        }
      }
    }
    const value=c.mutate(current=>{
      const {row}=bound(current,executionID);
      row.observation=observation;row.observedAt=now;
      if(result)row.result=result;
      // Generation receipt is not task DONE, verified cleanup, review or integration.
      return {value:structuredClone(row)};
    });
    // Deadline or Owner revocation: one interrupt request, never resend.
    const revoked=plan.ownerDecision!=='approve'||!state.executionPolicy||state.executionPolicy.revokedAt;
    if(!value.result&&!value.cancellation&&(now>value.submission.deadline||revoked))
      await this.cancel(executionID,`${revoked?'revoked':'timeout'}:${executionID}`);
    return structuredClone(c.read().executions.find(e=>e.id===executionID));
  }
  cancel(executionID,requestID){return requestCancellation(this.coordinator,executionID,requestID);}
  async verifyStop(rowOrID,host){
    if(typeof rowOrID==='string')return verifyExecutionStop(this.coordinator,rowOrID,this);
    const c=this.coordinator,state=c.read(),{row,member}=bound(state,rowOrID?.id);
    if(row.stopReceipt?.receiptID)return {stopped:true,executionID:row.id,identity:structuredClone(row.identity),receiptID:row.stopReceipt.receiptID};
    const session=host?.session??await c.ctx.session.get({sessionID:member.sessionID});
    verifyNativeBinding(state,member,session);
    const active=host?.active??await sessionActivity(c.ctx,member.sessionID);
    if(!active||typeof active!=='object'||Array.isArray(active)||active[row.sessionID])fail('PEER_STOP_NOT_PROVEN');
    if(!row.submission)return {stopped:true,executionID:row.id,identity:structuredClone(row.identity),receiptID:`stop:${row.id}:not-dispatched`};
    const current=await this.reconcile(row.id);
    if(current.result?.terminalID&&terminal.includes(current.result.outcome))
      return {stopped:true,executionID:current.id,identity:structuredClone(current.identity),receiptID:`stop:${current.id}:${current.submission.id}:${current.result.terminalID}`};
    const rows=await c.ctx.session.context({sessionID:member.sessionID});
    if(current.submission.state!=='admitted'&&Array.isArray(rows)&&!rows.some(r=>r?.type==='user'&&r.id===current.submission.id))
      return {stopped:true,executionID:current.id,identity:structuredClone(current.identity),receiptID:`stop:${current.id}:${current.submission.id}:unsubmitted`};
    fail('PEER_STOP_NOT_PROVEN');
  }
}
