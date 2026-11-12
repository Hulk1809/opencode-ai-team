import {createHash,randomUUID} from 'node:crypto';
import {taskReadiness,readyTasks} from './peer-readiness.mjs';
import {executionIdentity} from './peer-native.mjs';

export const PROTOCOL_VERSION=1;
export const DISCUSSION_ROUNDS=3;
export const ROUND_MS=30_000;
export const LEASE_MS=60_000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error(code);};
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('PROTOCOL_INPUT_INVALID');}
function text(value,max=10000){if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max)fail('PROTOCOL_TEXT_INVALID');return value;}
function list(value,max=64){if(!Array.isArray(value)||value.length>max||new Set(value).size!==value.length)fail('PROTOCOL_LIST_INVALID');for(const x of value)text(x,500);return value;}
function paths(value){list(value);for(const p of value)if(p.startsWith('/')||p.includes('\\')||p.split('/').some(s=>!s||s==='.'||s==='..')||/[\x00-\x1f]/.test(p))fail('PROTOCOL_PATH_INVALID');return value;}
const id=m=>m.id??m.role;
function binding(state,ctx){
  if(state?.mode!=='peer'||state.status!=='ready'||!state.teamID||state.canonicalRoot!==ctx.root||state.projectID!==ctx.projectID||state.teamID!==ctx.teamID)fail('PROTOCOL_SCOPE_MISMATCH');
}
function current(state,input){
  const plan=state.plans?.at(-1);
  if(!plan||input.planID!==plan.planID||input.planVersion!==plan.version)fail('PROTOCOL_STALE_PLAN');
  return plan;
}
function member(state,actor){const m=state.members.find(m=>id(m)===actor);if(!m)fail('PROTOCOL_MEMBER_REQUIRED');return m;}
const active=t=>!['DONE','CANCELLED','FAILED'].includes(t.status);
const protocolTasks=state=>state.tasks.filter(t=>t.protocolVersion===PROTOCOL_VERSION);

// Scope references are audit references, never execution grants. Owner authorization lives in main/RPC.
export function ingestPlan(state,input,ctx,attachment,now=Date.now()){
  object(input,['requestID','planID','expectedVersion','text','fileID','acceptanceCriteria','approvedScopeRef']);
  binding(state,ctx);text(input.requestID,100);
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('PROTOCOL_STALE_PLAN');
  list(input.acceptanceCriteria);if(!input.acceptanceCriteria.length)fail('PLAN_ACCEPTANCE_REQUIRED');text(input.approvedScopeRef,500);
  if((input.text!==undefined)===(input.fileID!==undefined))fail('PLAN_SOURCE_REQUIRED');
  const content=text(input.text??attachment?.content,200000);
  if(input.fileID!==undefined&&(!attachment||attachment.fileID!==input.fileID||attachment.projectID!==state.projectID||attachment.teamID!==state.teamID||attachment.canonicalRoot!==state.canonicalRoot||attachment.digest!==digest(content)))fail('PLAN_ATTACHMENT_FORBIDDEN');
  const hash=digest(JSON.stringify(input));
  const old=state.planRequests?.find(r=>r.requestID===input.requestID);
  if(old){if(old.hash!==hash)fail('PROTOCOL_IDEMPOTENCY_CONFLICT');return state.plans.find(p=>p.planID===old.planID&&p.version===old.version);}
  const previous=state.plans?.at(-1);
  if(state.tasks.some(t=>t.protocolVersion&&t.executionState==='outstanding'))fail('PLAN_OUTSTANDING_EXECUTION');
  if(input.expectedVersion!==(previous?.version??0)||previous&&input.planID!==previous.planID||!previous&&input.planID!==undefined)fail('PROTOCOL_STALE_PLAN');
  for(const t of protocolTasks(state))if(active(t)){t.status='CANCELLED';t.reason='Plan superseded';t.taskVersion++;t.ownershipGeneration++;}
  if(state.executionPolicy&&!state.executionPolicy.revokedAt){state.executionPolicy.revokedAt=now;state.executionPolicy.revokedReason='PLAN_SUPERSEDED';}
  const plan={protocolVersion:PROTOCOL_VERSION,planID:previous?.planID??`plan_${randomUUID()}`,version:input.expectedVersion+1,
    projectID:state.projectID,teamID:state.teamID,canonicalRoot:state.canonicalRoot,content,digest:digest(content),
    ...(input.fileID?{fileID:input.fileID}:{}),acceptanceCriteria:[...input.acceptanceCriteria],approvedScopeRef:input.approvedScopeRef,
    round:1,roundOpenedAt:now,discussion:[],discussionClosed:false,needsOwner:false,createdAt:now};
  state.plans??=[];state.plans.push(plan);state.planRequests??=[];state.planRequests.push({requestID:input.requestID,hash,planID:plan.planID,version:plan.version});
  state.protocolVersion=PROTOCOL_VERSION;
  state.messages.push({id:randomUUID(),from:'owner',to:'team',action:'plan',planID:plan.planID,planVersion:plan.version,text:content,at:new Date(now).toISOString()});
  return plan;
}

const common=['requestID','planID','planVersion','projectID','teamID','canonicalRoot'];
const taskKeys=['taskID','taskVersion','ownershipGeneration'];
const fields={read:[],discuss:['round','text','risk'],close_round:['round'],propose:['text','dependencies','files','requiredCapabilities','acceptanceCriteria','requiredChecks','assignedPeer','reviewPeer'],
  bid:[...taskKeys],ready:[...taskKeys],claim:[...taskKeys],renew:[...taskKeys,'leaseID'],release:[...taskKeys,'leaseID'],
  start:[...taskKeys,'leaseID'],submit:[...taskKeys,'leaseID','reportID'],review:[...taskKeys,'reportID','approved'],
  integrate:[...taskKeys],done:[...taskKeys],reassign_review:[...taskKeys],cancel:[...taskKeys,'text'],block:[...taskKeys,'leaseID','text'],fail:[...taskKeys,'leaseID','text'],reconcile:[...taskKeys]};
export const protocolFields=Object.fromEntries(Object.entries(fields).map(([action,keys])=>[action,[...common,...keys]]));
function taskFor(state,input){
  const t=protocolTasks(state).find(t=>t.id===input.taskID&&t.planID===input.planID&&t.planVersion===input.planVersion);
  if(!t||t.taskVersion!==input.taskVersion||t.ownershipGeneration!==input.ownershipGeneration)fail('PROTOCOL_STALE_TASK');return t;
}
function dependencies(state,t){return t.dependencies.every(d=>protocolTasks(state).some(x=>x.id===d&&x.planID===t.planID&&x.planVersion===t.planVersion&&x.status==='DONE'));}
function eligible(m,t){return t.requiredCapabilities.every(c=>(m.capabilities??['collaboration']).includes(c));}
export function claimant(state,t){
  const candidates=state.members.filter(m=>eligible(m,t)&&id(m)!==t.reviewPeer&&(t.assignedPeer?id(m)===t.assignedPeer:!t.bids.length||t.bids.includes(id(m))));
  const load=m=>protocolTasks(state).filter(t=>t.assignee===id(m)&&active(t)).length;
  return candidates.sort((a,b)=>load(a)-load(b)||(id(a)<id(b)?-1:id(a)>id(b)?1:0))[0];
}
function reviewer(state,primary){
  const load=m=>protocolTasks(state).filter(t=>t.reviewer===id(m)&&active(t)).length;
  return state.members.filter(m=>id(m)!==primary&&m.sessionID!==state.members.find(m=>id(m)===primary).sessionID)
    .sort((a,b)=>load(a)-load(b)||(id(a)<id(b)?-1:id(a)>id(b)?1:0))[0];
}
function lease(t,actor,input,now,completed=false){if(t.assignee!==actor||!t.lease||t.lease.id!==input.leaseID||!completed&&t.lease.expiresAt<=now)fail('PROTOCOL_LEASE_INVALID');}
function report(state,t,actor,reportID){
  const a=state.artifacts?.find(a=>a.id===reportID&&a.taskID===t.id&&a.owner===actor&&a.sessionID===member(state,actor).sessionID&&a.projectID===state.projectID&&a.teamID===state.teamID&&a.status==='completed'&&a.planVersion===t.planVersion&&a.ownershipGeneration===t.ownershipGeneration&&a.workRevision===t.workRevision);
  if(!a)fail('PROTOCOL_VERIFICATION_REQUIRED');
  const missing=t.requiredChecks.filter(check=>!a.checks?.some(c=>c.command===check&&c.exitCode===0));
  if(missing.length)fail(`PROTOCOL_VERIFICATION_REQUIRED: report.commands missing successful required checks ${JSON.stringify(missing)}; copy exact commands from team_worktree result, not wrapper tool name`);return a;
}
export function ownerSummary(state){
  const plan=state?.plans?.at(-1)??null;
  const tasks=plan?protocolTasks(state).filter(t=>t.planID===plan.planID&&t.planVersion===plan.version):[];
  const counts={total:tasks.length,DONE:0,INTEGRATED:0,REVIEW:0,SUBMITTED:0,RUNNING:0,CLAIMED:0,READY:0,DRAFT:0,REWORK:0,CANCELLED:0,FAILED:0,BLOCKED:0};
  for(const t of tasks)counts[t.status]=(counts[t.status]??0)+1;
  return {
    plan:plan?{planID:plan.planID,version:plan.version,digest:plan.digest,discussionClosed:plan.discussionClosed,needsOwner:plan.needsOwner,ownerDecision:plan.ownerDecision??null}:null,
    peers:(state?.members??[]).map(m=>({id:id(m),sessionID:m.sessionID,branch:m.branch??null})),
    counts,
    allDone:tasks.length>0&&tasks.every(t=>t.status==='DONE'),
    executionMode:'controlled-adapter-only',
    tasks:tasks.map(t=>{
      const integration=state?.integrations?.find(r=>r.state==='merged'&&r.taskID===t.id&&r.input.ownershipGeneration===t.ownershipGeneration&&r.input.workRevision===t.workRevision);
      return {id:t.id,status:t.status,assignee:t.assignee,reviewer:t.reviewer,ownershipGeneration:t.ownershipGeneration,workRevision:t.workRevision,executionState:t.executionState,submission:t.submission??null,reviewReportID:t.review?.reportID??null,integrationReceiptID:integration?.id??null,resultCommit:integration?.resultCommit??null};
    })
  };
}

// ponytail: fixed membership, no native dispatch; add membership changes only with trusted revision/recovery.
// Transactional reducer. Native execution admission/stopped evidence comes from trusted host, never payload.
export function protocolAction(state,actor,action,input,ctx,{now=Date.now(),admit=()=>false,stopped=()=>false,verifyReport=()=>false,owner=false}={}){
  if(!Object.hasOwn(fields,action))fail('PROTOCOL_ACTION_INVALID');
  object(input,[...common,...fields[action]]);binding(state,ctx);
  if(!(owner&&actor==='owner'&&action==='propose'))member(state,actor);
  if(input.projectID!==ctx.projectID||input.teamID!==ctx.teamID||input.canonicalRoot!==ctx.root)fail('PROTOCOL_SCOPE_MISMATCH');
  text(input.requestID,100);
  const hash=digest(JSON.stringify([action,input]));
  const old=state.protocolRequests?.find(r=>r.actor===actor&&r.requestID===input.requestID);
  if(old){if(old.hash!==hash)fail('PROTOCOL_IDEMPOTENCY_CONFLICT');return structuredClone(old.result);}
  const plan=current(state,input);
  if(plan.ownerDecision==='reject'&&action!=='read')fail('PROTOCOL_PLAN_REJECTED');
  if(action==='read')return {plan:structuredClone(plan),tasks:structuredClone(protocolTasks(state).filter(t=>t.planID===plan.planID&&t.planVersion===plan.version)),readyTaskIDs:readyTasks(state).map(t=>t.id),readiness:protocolTasks(state).filter(t=>t.planID===plan.planID&&t.planVersion===plan.version).map(t=>({taskID:t.id,...taskReadiness(state,t)})),approvals:structuredClone(state.approvals??[]),summary:ownerSummary(state),policy:{maxRounds:DISCUSSION_ROUNDS,roundMS:ROUND_MS,leaseMS:LEASE_MS,claimant:'eligible bidders, then lowest active primary load, then stable member ID lexical order',reviewer:'different member AND native session; lowest active review load, then stable member ID',executionEnabled:false}};
  let result;
  if(action==='discuss'){
    if(plan.discussionClosed||input.round!==plan.round||plan.discussion.some(d=>d.round===input.round&&d.memberID===actor))fail('PROTOCOL_DISCUSSION_LIMIT');
    text(input.text);if(!['none','architecture','scope','approval'].includes(input.risk))fail('PROTOCOL_RISK_INVALID');
    plan.discussion.push({memberID:actor,round:input.round,text:input.text,risk:input.risk});
    if(input.risk!=='none'){
      plan.needsOwner=true;
      state.messages.push({id:randomUUID(),from:actor,to:'owner',action:'approval_request',planID:plan.planID,planVersion:plan.version,text:input.text,at:new Date(now).toISOString()});
    }
    result={round:plan.round,needsOwner:plan.needsOwner};
  }else if(action==='close_round'){
    if(plan.discussionClosed||input.round!==plan.round)fail('PROTOCOL_DISCUSSION_LIMIT');
    if(now<plan.roundOpenedAt+ROUND_MS&&!state.members.every(m=>plan.discussion.some(d=>d.round===plan.round&&d.memberID===id(m))))fail('PROTOCOL_ROUND_OPEN');
    if(plan.round===DISCUSSION_ROUNDS)plan.discussionClosed=true;else{plan.round++;plan.roundOpenedAt=now;}
    result={round:plan.round,closed:plan.discussionClosed,needsOwner:plan.needsOwner};
  }else if(action==='propose'){
    if(plan.discussionClosed&&!owner)fail('PROTOCOL_DISCUSSION_LIMIT');
    if(protocolTasks(state).filter(t=>t.planID===plan.planID&&t.planVersion===plan.version&&t.proposedBy===actor).length>=32)fail('PROTOCOL_PROPOSAL_LIMIT');
    text(input.text);list(input.dependencies);paths(input.files);list(input.requiredCapabilities);list(input.acceptanceCriteria);list(input.requiredChecks);
    if(!input.acceptanceCriteria.length||!input.requiredChecks.length)fail('PROTOCOL_ACCEPTANCE_REQUIRED');
    if(input.assignedPeer!==undefined)member(state,input.assignedPeer);
    if(input.reviewPeer!==undefined){
      const r=member(state,input.reviewPeer);
      if(input.assignedPeer&&(input.reviewPeer===input.assignedPeer||r.sessionID===member(state,input.assignedPeer).sessionID))fail('PROTOCOL_INDEPENDENT_REVIEW_REQUIRED');
    }
    // Append-only dependency graph: edges point only to existing tasks in this exact plan version; cycles impossible.
    if(input.dependencies.some(d=>!protocolTasks(state).some(t=>t.id===d&&t.planID===plan.planID&&t.planVersion===plan.version)))fail('PROTOCOL_DEPENDENCY_INVALID');
    const t={protocolVersion:PROTOCOL_VERSION,id:`task_${randomUUID()}`,planID:plan.planID,planVersion:plan.version,taskVersion:1,ownershipGeneration:0,workRevision:1,
      text:input.text,status:'DRAFT',assignee:'unclaimed',reviewer:null,proposedBy:actor,dependencies:[...input.dependencies],files:[...input.files],requiredCapabilities:[...input.requiredCapabilities],acceptanceCriteria:[...input.acceptanceCriteria],requiredChecks:[...input.requiredChecks],bids:[],executionState:'not-started'};
    if(input.assignedPeer!==undefined)t.assignedPeer=input.assignedPeer;
    if(input.reviewPeer!==undefined)t.reviewPeer=input.reviewPeer;
    if(!state.members.some(m=>eligible(m,t)&&(!t.assignedPeer||id(m)===t.assignedPeer)&&id(m)!==t.reviewPeer))fail('PROTOCOL_NO_ELIGIBLE_MEMBER');
    if(owner)t.assignmentSource='owner';
    state.tasks.push(t);result=structuredClone(t);
  }else{
    const t=taskFor(state,input);
    if(action==='bid'){
      if(t.status!=='DRAFT'||plan.discussionClosed||!eligible(member(state,actor),t))fail('PROTOCOL_BID_INVALID');
      if(!t.bids.includes(actor))t.bids.push(actor);
    }else if(action==='ready'){
      if(t.status!=='DRAFT'||!plan.discussionClosed||plan.needsOwner||state.members.length<2)fail('PROTOCOL_NOT_READY');t.status='READY';
    }else if(action==='claim'){
      if(t.status!=='READY'||plan.needsOwner||id(claimant(state,t)??{})!==actor)fail('PROTOCOL_CLAIM_DENIED');
      if(!taskReadiness(state,t).ready)fail('PROTOCOL_DEPENDENCIES_OR_STATE');
      if(protocolTasks(state).some(x=>x.id!==t.id&&(x.executionState==='outstanding'||x.assignee!=='unclaimed'&&active(x))&&x.files.some(a=>t.files.some(b=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/')))))fail('PROTOCOL_FILE_CONFLICT');
      const r=t.reviewPeer?member(state,t.reviewPeer):reviewer(state,actor);if(!r||id(r)===actor||r.sessionID===member(state,actor).sessionID)fail('PROTOCOL_REVIEWER_REQUIRED');
      t.assignee=actor;t.reviewer=id(r);t.status='CLAIMED';t.ownershipGeneration++;t.lease={id:`lease_${randomUUID()}`,expiresAt:now+LEASE_MS};
    }else if(action==='renew'){
      // Completed worker may renew for submission only; identity and stop proof remain mandatory.
      const completed=t.status==='RUNNING'&&t.executionState==='stopped'&&stopped(t)===true;
      lease(t,actor,input,now,completed);if(!['CLAIMED','RUNNING','REWORK','BLOCKED'].includes(t.status))fail('PROTOCOL_TRANSITION_INVALID');t.lease.expiresAt=now+LEASE_MS;
    }else if(action==='release'){
      lease(t,actor,input,now);if(t.status!=='CLAIMED'||t.executionState!=='not-started')fail('PROTOCOL_STOP_NOT_PROVEN');
      t.status='READY';t.assignee='unclaimed';t.reviewer=null;t.lease=null;t.ownershipGeneration++;
    }else if(action==='start'){
      lease(t,actor,input,now);
      if(!['CLAIMED','REWORK'].includes(t.status)||plan.needsOwner||!dependencies(state,t))fail('PROTOCOL_DEPENDENCIES_OR_STATE');
      if(admit({state,plan,task:t,actor})!==true)fail('PROTOCOL_EXECUTION_NOT_AUTHORIZED');
      t.status='RUNNING';t.executionState='outstanding';
      state.executions??=[];
      state.executions.push({id:`execution_${randomUUID()}`,taskID:t.id,sessionID:member(state,actor).sessionID,identity:executionIdentity(state,t),state:'admitted-by-adapter',observation:'unknown',createdAt:now});
    }else if(action==='submit'){
      lease(t,actor,input,now);if(t.status!=='RUNNING')fail('PROTOCOL_TRANSITION_INVALID');
      report(state,t,actor,input.reportID);if(verifyReport(input.reportID)!==true||stopped(t)!==true)fail('PROTOCOL_STOP_OR_REPORT_NOT_PROVEN');
      t.status='SUBMITTED';t.submission=input.reportID;t.executionState='stopped';t.reviewAssignedAt=now;
    }else if(action==='review'){
      if(!['SUBMITTED','REVIEW'].includes(t.status)||t.reviewer!==actor||t.assignee===actor||typeof input.approved!=='boolean')fail('PROTOCOL_INDEPENDENT_REVIEW_REQUIRED');
      if(input.approved){report(state,t,actor,input.reportID);if(verifyReport(input.reportID)!==true)fail('PROTOCOL_VERIFICATION_REQUIRED');t.status='REVIEW';t.review={memberID:actor,reportID:input.reportID,workRevision:t.workRevision,ownershipGeneration:t.ownershipGeneration};}
      else{t.status='REWORK';t.workRevision++;t.review=null;t.submission=null;t.lease={id:`lease_${randomUUID()}`,expiresAt:now+LEASE_MS};}
    }else if(action==='reassign_review'){
      if(!['SUBMITTED','REVIEW'].includes(t.status)||now<(t.reviewAssignedAt??now)+LEASE_MS)fail('PROTOCOL_REVIEW_TIMEOUT_REQUIRED');
      const candidates=state.members.filter(m=>id(m)!==t.reviewer&&id(m)!==t.assignee&&m.sessionID!==member(state,t.assignee).sessionID).sort((a,b)=>id(a)<id(b)?-1:1);
      if(!candidates.length)fail('PROTOCOL_OWNER_REVIEW_RECOVERY_REQUIRED');
      t.reviewer=id(candidates[0]);t.reviewAssignedAt=now;t.review=null;t.status='SUBMITTED';
    }else if(action==='integrate'||action==='done'){
      if(t.reviewer!==actor||t.assignee===actor||t.status!==(action==='integrate'?'REVIEW':'INTEGRATED')||!t.review||t.review.workRevision!==t.workRevision||t.review.ownershipGeneration!==t.ownershipGeneration||!dependencies(state,t))fail('PROTOCOL_INDEPENDENT_REVIEW_REQUIRED');
      report(state,t,t.assignee,t.submission);report(state,t,actor,t.review.reportID);
      if(verifyReport(t.submission)!==true||verifyReport(t.review.reportID)!==true)fail('PROTOCOL_VERIFICATION_REQUIRED');
      if(state.members.some(m=>m.branch)&&!state.integrations?.some(r=>r.state==='merged'&&r.taskID===t.id&&r.input.ownershipGeneration===t.ownershipGeneration&&r.input.workRevision===t.workRevision&&r.reviewReportID===t.review.reportID&&r.submission===t.submission))fail('PROTOCOL_MERGE_NOT_PROVEN');
      t.status=action==='integrate'?'INTEGRATED':'DONE';
    }else if(action==='cancel'){
      text(input.text);if(!active(t))fail('PROTOCOL_TRANSITION_INVALID');t.status='CANCELLED';t.reason=input.text;
      // Outstanding native work is not stopped by cancellation or elapsed lease.
    }else if(action==='block'||action==='fail'){
      lease(t,actor,input,now);text(input.text);if(!['CLAIMED','RUNNING','REWORK'].includes(t.status))fail('PROTOCOL_TRANSITION_INVALID');t.status=action==='block'?'BLOCKED':'FAILED';t.reason=input.text;
    }else if(action==='reconcile'){
      const identity=JSON.stringify(executionIdentity(state,t));
      const attempt=state.executions?.findLast(e=>e.taskID===t.id&&JSON.stringify(e.identity)===identity);
      const failedAttempt=t.assignee===actor&&t.status==='RUNNING'&&t.executionState==='stopped'&&attempt?.state==='stop-verified'&&attempt.stopReceipt?.outcome==='failed'&&stopped(t)===true;
      if(!t.lease||t.lease.expiresAt>now&&!failedAttempt)fail('PROTOCOL_LEASE_NOT_EXPIRED');
      if(t.executionState!=='not-started'&&stopped(t)!==true)fail('PROTOCOL_STOP_NOT_PROVEN');
      t.executionState='stopped';t.ownershipGeneration++;t.lease=null;
      if(active(t)){t.status='READY';t.assignee='unclaimed';t.reviewer=null;t.executionState='not-started';t.workRevision++;t.submission=null;t.review=null;}
    }
    t.taskVersion++;result=structuredClone(t);
  }
  state.protocolRequests??=[];state.protocolRequests.push({actor,requestID:input.requestID,hash,result:structuredClone(result)});
  return result;
}
