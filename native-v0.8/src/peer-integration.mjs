import {execFileSync} from 'node:child_process';
import {realpathSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute,dirname,join} from 'node:path';
import {readReport} from './pilot-reports.mjs';
import {consumeOwnerGrant} from './pilot-owner-authority.mjs';
import {PEER_GENERATION,planHash} from './peer-team.mjs';

// ADAPT Ensemble isolated branch integration; V0.8 sole store + Noriq revision-bound review.
const env=()=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Peer Integration','-c','user.email=integration@localhost','-C',cwd,...args],{env:env(),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fresh(state,input){
  const t=state.tasks.find(t=>t.id===input.taskID);
  if(!t||t.status!=='REVIEW'||t.taskVersion!==input.taskVersion||t.ownershipGeneration!==input.ownershipGeneration||t.workRevision!==input.workRevision||!t.review||t.review.workRevision!==t.workRevision||t.review.ownershipGeneration!==t.ownershipGeneration||t.review.memberID===t.assignee)throw Error('PEER_INTEGRATION_STALE_REVIEW');
  const latest=state.plans?.at(-1);
  if(!latest||latest.planID!==t.planID||latest.version!==t.planVersion||latest.needsOwner)throw Error('PEER_INTEGRATION_STALE_PLAN');
  if(t.executionState!=='stopped'||t.review.memberID!==t.reviewer||state.members.find(m=>m.id===t.assignee)?.sessionID===state.members.find(m=>m.id===t.reviewer)?.sessionID)throw Error('PEER_INTEGRATION_STALE_REVIEW');
  return t;
}
function reports(coordinator,state,task){
  for(const [id,owner] of [[task.submission,task.assignee],[task.review.reportID,task.reviewer]]){
    const r=readReport(coordinator.directory,state,state.projectID,id);
    if(r.owner!==owner||r.taskID!==task.id||r.status!=='completed'||r.planVersion!==task.planVersion||r.ownershipGeneration!==task.ownershipGeneration||r.workRevision!==task.workRevision||!task.requiredChecks.every(c=>r.checks?.some(x=>x.command===c&&x.exitCode===0)))throw Error('PEER_INTEGRATION_REPORT_INVALID');
  }
}
// Temporary integrator peer never holds Owner authority; only an explicit one-use Owner grant authorizes integration.
export function createIntegrationAuthority(coordinator,{authorization,generation=PEER_GENERATION}={}){
  return {
    authorize:async req=>{
      if(typeof authorization!=='string'||generation!==PEER_GENERATION)return false;
      const payload={requestID:req.requestID,taskID:req.taskID,taskVersion:req.taskVersion,ownershipGeneration:req.ownershipGeneration,workRevision:req.workRevision,baseCommit:req.baseCommit,sourceCommit:req.sourceCommit,directory:req.directory};
      consumeOwnerGrant(authorization,{root:coordinator.root,projectID:req.projectID,operation:'integrateTask',generation,requestID:req.requestID,planHash:planHash(payload)});
      return true;
    },
    verifyReview:async req=>{
      const state=coordinator.read();
      const sub=readReport(coordinator.directory,state,req.projectID,req.submission);
      const rev=readReport(coordinator.directory,state,req.projectID,req.reviewReportID);
      return sub.owner!==rev.owner&&sub.sessionID!==rev.sessionID&&rev.content.includes(req.sourceCommit)&&sub.content.includes(req.sourceCommit);
    }
  };
}
// Trusted host API, not exposed as peer RPC. Authorization adapter must validate exact scope.
export async function integrateReviewedTask(coordinator,input,authority){
  if(!input||Object.keys(input).some(k=>!['requestID','taskID','taskVersion','ownershipGeneration','workRevision','baseCommit','sourceCommit','directory'].includes(k))||typeof input.requestID!=='string'||!input.requestID.trim()||input.requestID.length>100||![input.baseCommit,input.sourceCommit].every(x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x))||!isAbsolute(input.directory??''))throw Error('PEER_INTEGRATION_INVALID');
  const state=coordinator.read();
  if(typeof authority?.authorize!=='function'||await authority.authorize({projectID:state.projectID,teamID:state.teamID,...input})!==true)throw Error('PEER_INTEGRATION_NOT_AUTHORIZED');
  const prior=state.integrations?.find(r=>r.requestID===input.requestID);
  if(prior){if(JSON.stringify(prior.input)!==JSON.stringify(input))throw Error('PEER_INTEGRATION_IDEMPOTENCY_CONFLICT');return prior;}
  const task=fresh(state,input);reports(coordinator,state,task);
  if(typeof authority.verifyReview!=='function'||await authority.verifyReview({projectID:state.projectID,teamID:state.teamID,planID:task.planID,planVersion:task.planVersion,reviewReportID:task.review.reportID,submission:task.submission,...input})!==true)throw Error('PEER_INTEGRATION_REVIEW_BINDING_NOT_PROVEN');
  const root=coordinator.root;
  if(realpathSync(root)!==root||existsSync(input.directory)||state.members.some(m=>m.directory===input.directory))throw Error('PEER_INTEGRATION_WORKSPACE_INVALID');
  const parent=join(dirname(root),`.${root.split('/').at(-1)}-integrations`);
  if(dirname(input.directory)!==parent||realpathSync(parent)!==parent||input.directory.includes('\0'))throw Error('PEER_INTEGRATION_WORKSPACE_INVALID');
  const primary=state.members.find(m=>m.id===task.assignee);
  if(!primary?.branch||git(primary.directory,'symbolic-ref','--short','HEAD')!==primary.branch||git(primary.directory,'rev-parse','HEAD')!==input.sourceCommit||git(primary.directory,'status','--porcelain')||git(root,'rev-parse','HEAD')!==input.baseCommit)throw Error('PEER_INTEGRATION_COMMIT_INVALID');
  git(root,'merge-base',input.baseCommit,input.sourceCommit);
  const sourceDiff=git(root,'diff','--name-only',input.baseCommit,input.sourceCommit).split('\n').filter(Boolean);
  if(!sourceDiff.length||sourceDiff.some(p=>!task.files.some(f=>p===f||p.startsWith(f+'/'))))throw Error('PEER_INTEGRATION_SCOPE_INVALID');
  for(const commit of [input.baseCommit,input.sourceCommit])if(git(root,'rev-parse',`${commit}^{commit}`)!==commit)throw Error('PEER_INTEGRATION_COMMIT_INVALID');
  const sourceTree=git(primary.directory,'rev-parse',`${input.sourceCommit}^{tree}`);
  const receiptID=`integration_${randomUUID()}`;
  coordinator.mutate(current=>{
    reports(coordinator,current,fresh(current,input));current.integrations??=[];
    if(current.integrations.some(r=>r.requestID===input.requestID||r.input.directory===input.directory||(r.taskID===input.taskID&&(['preparing','uncertain','merged'].includes(r.state)||(r.input.ownershipGeneration===input.ownershipGeneration&&r.input.workRevision===input.workRevision)))))throw Error('PEER_INTEGRATION_ALREADY_RESERVED');
    current.integrations.push({id:receiptID,requestID:input.requestID,taskID:input.taskID,input:structuredClone(input),reviewReportID:task.review.reportID,submission:task.submission,state:'preparing'});return {};
  });
  let outcome={state:'uncertain'};
  try{
    git(root,'worktree','add','--detach',input.directory,input.baseCommit);
    if(realpathSync(input.directory)!==input.directory||git(input.directory,'rev-parse','--path-format=absolute','--git-common-dir')!==git(root,'rev-parse','--path-format=absolute','--git-common-dir')||git(input.directory,'rev-parse','HEAD')!==input.baseCommit||git(input.directory,'status','--porcelain'))throw Error('PEER_INTEGRATION_WORKSPACE_INVALID');
    const before=coordinator.read();reports(coordinator,before,fresh(before,input));
    if(git(root,'rev-parse','HEAD')!==input.baseCommit||git(primary.directory,'rev-parse','HEAD')!==input.sourceCommit||git(primary.directory,'rev-parse',`${input.sourceCommit}^{tree}`)!==sourceTree)throw Error('PEER_INTEGRATION_COMMIT_INVALID');
    try{git(input.directory,'merge','--no-ff','--no-edit',input.sourceCommit);}
    catch(error){if(git(input.directory,'ls-files','-u'))outcome={state:'conflict',conflicts:git(input.directory,'diff','--name-only','--diff-filter=U')};else throw error;}
    if(outcome.state!=='conflict'){
      const resultCommit=git(input.directory,'rev-parse','HEAD');
      git(input.directory,'merge-base','--is-ancestor',input.baseCommit,resultCommit);git(input.directory,'merge-base','--is-ancestor',input.sourceCommit,resultCommit);
      if(git(input.directory,'status','--porcelain'))throw Error('PEER_INTEGRATION_DIRTY');
      const changed=git(input.directory,'diff','--name-only',input.baseCommit,resultCommit).split('\n').filter(Boolean);
      if(!changed.length||changed.some(p=>!task.files.some(f=>p===f||p.startsWith(f+'/'))))throw Error('PEER_INTEGRATION_SCOPE_INVALID');
      outcome={state:'merged',resultCommit,tree:git(input.directory,'rev-parse','HEAD^{tree}'),sourceTree,baseCommit:input.baseCommit,sourceCommit:input.sourceCommit};
    }
  }catch(error){outcome={state:'uncertain',error:String(error.message)};}
  return coordinator.mutate(current=>{
    const row=current.integrations.find(r=>r.id===receiptID);
    try{reports(coordinator,current,fresh(current,input));}catch{outcome={...outcome,state:'stale',mergeOutcome:outcome.state};}
    Object.assign(row,outcome,{at:new Date().toISOString()});return {value:structuredClone(row)};
  });
}
