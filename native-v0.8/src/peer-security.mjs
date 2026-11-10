import {realpathSync,lstatSync} from 'node:fs';
import {isAbsolute,relative,resolve} from 'node:path';

const fail=code=>{throw Error(code);};
const string=v=>typeof v==='string'&&v.length>0&&v.length<=500&&!/[\x00-\x1f]/.test(v);
const list=v=>Array.isArray(v)&&v.length>0&&v.length<=64&&v.every(string)&&new Set(v).size===v.length;
export const SECURITY_VERSION=1;

// These are constraints for a future trusted Owner bridge, not a renderer/tool grant issuer.
export function validateApproval(record,binding,now=Date.now()){
  const keys=['id','ownerID','projectID','teamID','canonicalRoot','repository','branches','operations','resources','issuedAt','expiresAt','revokedAt','generation','budget'];
  if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(k=>!keys.includes(k))||
    !['id','ownerID','projectID','teamID','canonicalRoot','generation'].every(k=>string(record[k]))||
    !list(record.operations)||!list(record.resources)||!Array.isArray(record.branches)||record.branches.some(b=>!string(b)||b.includes('*'))||
    record.operations.some(x=>!['read','edit','shell','network','git','model.prompt','integrate'].includes(x))||record.resources.some(x=>/[?*]/.test(x)||!isAbsolute(x)||resolve(x)!==x)||
    !Number.isSafeInteger(record.issuedAt)||!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=record.issuedAt||record.issuedAt>now)fail('APPROVAL_INVALID');
  if(record.revokedAt!==null)fail('APPROVAL_REVOKED');
  if(record.expiresAt<=now)fail('APPROVAL_EXPIRED');
  for(const key of ['projectID','teamID','canonicalRoot','generation'])if(record[key]!==binding[key])fail('APPROVAL_SCOPE_MISMATCH');
  if(realpathSync(record.canonicalRoot)!==record.canonicalRoot||record.repository!==null&&record.repository!==record.canonicalRoot)fail('APPROVAL_REPOSITORY_MISMATCH');
  const b=record.budget;
  if(!b||Object.keys(b).some(k=>!['currency','maxCostMicros','maxPrompts','maxConcurrent','maxRetries'].includes(k))||b.currency!=='USD'||
    !Number.isSafeInteger(b.maxCostMicros)||b.maxCostMicros<0||!Number.isSafeInteger(b.maxPrompts)||b.maxPrompts<1||
    !Number.isInteger(b.maxConcurrent)||b.maxConcurrent<1||b.maxConcurrent>4||!Number.isInteger(b.maxRetries)||b.maxRetries<0||b.maxRetries>3)fail('APPROVAL_BUDGET_INVALID');
  return record;
}

export function approvedPath(root,path){
  if(!string(path)||isAbsolute(path)||path.includes('\\')||path.split('/').some(x=>!x||x==='.'||x==='..')||/^[a-z][a-z\d+.-]*:/i.test(path))fail('APPROVAL_PATH_INVALID');
  if(realpathSync(root)!==root)fail('APPROVAL_PATH_INVALID');
  let current=root;
  for(const part of path.split('/')){current=resolve(current,part);if(lstatSync(current).isSymbolicLink())fail('APPROVAL_SYMLINK_FORBIDDEN');}
  const rel=relative(root,realpathSync(current));if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('APPROVAL_PATH_ESCAPE');
  // Validation only. Not a race-free file opener or filesystem sandbox.
  return current;
}

export function checkApprovedOperation(record,binding,operation,{now=Date.now(),ownerVerified=false,revocationVerified=false}={}){
  validateApproval(record,binding,now);
  if(!ownerVerified||!revocationVerified)fail('APPROVAL_AUTHORITY_NOT_PROVEN');
  if(!operation||!record.operations.includes(operation.action)||!record.resources.includes(operation.resource)||operation.repository!==record.repository||
    ['git','integrate'].includes(operation.action)&&(record.repository===null||operation.branch===null)||
    operation.branch!==null&&!record.branches.includes(operation.branch))fail('APPROVAL_OPERATION_FORBIDDEN');
  return true;
}

export function securityView(state){
  return {version:SECURITY_VERSION,liveExecution:'BLOCKED',maxConcurrent:4,approvedOperations:[],
    isolation:state.isolation??'unknown',nonGitWrites:false,cleanupEnabled:false,
    blockers:['HOST_CONTAINMENT_NOT_PROVEN','EFFECTIVE_PERMISSIONS_NOT_ATTESTED','OWNER_SCOPE_NOT_GRANTED','HARD_BUDGET_NOT_PROVEN','NATIVE_ADMISSION_STOP_NOT_PROVEN'],
    // ponytail: no trusted sandbox/budget adapter exists; do not turn peer input or cached readbacks into attestations.
    effectivePermissions:'NOT_PROVEN',pricing:'CATALOG_ONLY',quota:'NOT_PROVEN',hardSpendingCap:'NOT_PROVEN'};
}

// Distinguishes coordinator allowlist/binding checks from OS/host containment enforcement.
export function evaluateEffectivePermissions({state,member,session,approval=null,operation=null,ownerVerified=false,revocationVerified=false,hostAttested=false,now=Date.now()}={}){
  const blockers=[];
  const bindingOk=!!state&&state.mode==='peer'&&!!member&&!!session&&session.id===member.sessionID&&session.projectID===state.projectID&&session.agent===member.agent&&session.location?.directory===member.directory&&(session.location?.workspaceID??null)===(member.workspaceID??null);
  if(!bindingOk)blockers.push('NATIVE_SESSION_BINDING_MISMATCH');
  const perms=Array.isArray(session?.permissions)?session.permissions:[];
  const sessionDenyLocked=['edit','shell','subagent'].every(a=>perms.some(p=>p.action===a&&p.resource==='*'&&p.effect==='deny')&&!perms.some(p=>p.action===a&&p.effect!=='deny'));
  if(!sessionDenyLocked)blockers.push('SESSION_PERMISSIONS_NOT_LOCKED');
  const isolatedGit=state?.isolation==='git-worktree'&&typeof member?.directory==='string'&&member.directory!==state.canonicalRoot&&typeof member.branch==='string'&&!['main','master'].includes(member.branch);
  if(operation&&['edit','shell','git','integrate'].includes(operation.action)&&!isolatedGit)blockers.push('WORKSPACE_ISOLATION_REQUIRED');
  let scopeOk=false;
  if(operation){
    try{
      scopeOk=checkApprovedOperation(approval,{projectID:state?.projectID,teamID:state?.teamID,canonicalRoot:state?.canonicalRoot,generation:state?.generation},operation,{now,ownerVerified,revocationVerified});
      if(operation.relativePath!==undefined&&member?.directory)approvedPath(member.directory,operation.relativePath);
    }catch(e){blockers.push(e.message);}
  }
  if(!hostAttested)blockers.push('HOST_CONTAINMENT_NOT_PROVEN','EFFECTIVE_PERMISSIONS_NOT_ATTESTED');
  return {
    allowed:bindingOk&&sessionDenyLocked&&(!operation||scopeOk)&&hostAttested,
    coordinatorChecks:{bindingOk,sessionDenyLocked,isolatedGit,scopeOk},
    hostEnforcement:hostAttested?'ATTESTED':'NOT_PROVEN',
    sharedOsUidWarning:!hostAttested,
    blockers
  };
}

// Distinguishes catalog pricing, soft coordinator caps, provider hard caps, and verified stop.
export function evaluateCostAndStopControl({state,approval=null,catalog=[],model=null,usage=null,session=null,spentMicros=0,promptsUsed=0,activeCount=0,retriesUsed=0,providerCapVerified=false,stopVerified=false,now=Date.now()}={}){
  const blockers=[];
  const entry=Array.isArray(catalog)?catalog.find(m=>m.providerID===model?.providerID&&m.id===model?.id&&(model?.variant==null||m.variants?.includes(model.variant))):null;
  // Never treat cost=[], usage=null or 0 as free or verified pricing.
  const pricingVerified=!!entry&&Array.isArray(entry.cost)&&entry.cost.length>0&&entry.cost.every(c=>Number.isFinite(c.input)&&c.input>0&&Number.isFinite(c.output)&&c.output>0);
  if(!pricingVerified)blockers.push('PRICING_NOT_PROVEN_OR_ZERO');
  const quotaEntry=Array.isArray(usage)?usage.find(u=>u?.providerID===model?.providerID&&u.status==='ok'&&Array.isArray(u.entries)&&u.entries.length>0):null;
  const quotaVerified=!!quotaEntry&&quotaEntry.entries.every(e=>Number.isFinite(e.used)&&e.used>=0&&Number.isFinite(e.limit)&&e.limit>0&&e.used<e.limit);
  if(!quotaVerified)blockers.push('QUOTA_NOT_PROVEN');
  const sessionUsageProven=Number.isFinite(session?.cost)&&session.cost>0&&Number.isFinite(session?.tokens?.input)&&session.tokens.input>=0&&Number.isFinite(session?.tokens?.output)&&session.tokens.output>=0;
  let budgetWithinEnvelope=false;
  try{
    const b=validateApproval(approval,{projectID:state?.projectID,teamID:state?.teamID,canonicalRoot:state?.canonicalRoot,generation:state?.generation},now).budget;
    budgetWithinEnvelope=b.maxCostMicros>0&&Number.isSafeInteger(spentMicros)&&spentMicros>=0&&spentMicros<b.maxCostMicros&&Number.isSafeInteger(promptsUsed)&&promptsUsed>=0&&promptsUsed<b.maxPrompts&&Number.isSafeInteger(activeCount)&&activeCount>=0&&activeCount<b.maxConcurrent&&Number.isSafeInteger(retriesUsed)&&retriesUsed>=0&&retriesUsed<=b.maxRetries;
    if(!budgetWithinEnvelope)blockers.push('BUDGET_ENVELOPE_EXCEEDED');
  }catch(e){blockers.push(e.message);}
  if(!providerCapVerified)blockers.push('HARD_BUDGET_NOT_PROVEN');
  if(!stopVerified)blockers.push('NATIVE_ADMISSION_STOP_NOT_PROVEN');
  const allowed=pricingVerified&&quotaVerified&&budgetWithinEnvelope&&providerCapVerified&&stopVerified;
  return {
    unattendedPaidExecution:allowed?'ALLOWED':'BLOCKED',
    pricingVerified,
    quotaVerified,
    sessionUsageProven,
    budgetWithinEnvelope,
    controls:{
      estimatedBudget:pricingVerified?'CATALOG_RATES_POSITIVE':'NOT_PROVEN',
      softCoordinatorCap:budgetWithinEnvelope?'WITHIN_ENVELOPE':'EXCEEDED_OR_INVALID',
      providerHardCap:providerCapVerified?'ATTESTED':'NOT_PROVEN',
      verifiedStop:stopVerified?'PROVEN':'NOT_PROVEN'
    },
    blockers
  };
}

export function denyLiveAdmission(){fail('PEER_LIVE_EXECUTION_BLOCKED');}
