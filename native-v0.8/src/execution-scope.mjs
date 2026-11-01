// Not wired to native tools. Deploy only behind authenticated transport and an OS boundary.
import {randomUUID} from 'node:crypto';
import {digest,verifyDecision} from './broker.mjs';

const operations=['edit','test','commit','push','createPR','dockerBuild','deploy'];
const roles=['admin','frontend','backend','devops','qa'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.sort().join(',');
const list=(x,p)=>Array.isArray(x)&&x.length>0&&x.length<=1000&&x.every(p)&&new Set(x).size===x.length;
const path=x=>typeof x==='string'&&x.length<=1024&&!x.startsWith('/')&&!x.includes('\\')&&x.split('/').every(s=>s&&s!=='.'&&s!=='..'&&/^[A-Za-z0-9_.-]+$/.test(s));
const repo=x=>typeof x==='string'&&/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(x)&&!x.endsWith('/..');
const branch=x=>typeof x==='string'&&x.startsWith('ai-team/')&&path(x)&&!x.includes('..')&&!x.includes('@{')&&!x.endsWith('.lock')&&!x.endsWith('.');
const protectedPath=x=>x==='.github'||x.startsWith('.github/')||x.split('/').some(s=>/^\.env(?:\.|$)/i.test(s)||/^(?:secrets?|credentials?)(?:\.|$)/i.test(s));
const image=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>0;
const allowedPath=(p,roots)=>roots.some(root=>p===root||p.startsWith(root+'/'));
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};

export function validateExecutionPolicy(p){
  requireValue(exact(p,['version','projectID','scopeID','members','repositories','branches','sourcePaths','permissions','sensitivePaths','docker','limits']), 'Invalid policy fields');
  requireValue(p.version===1&&id(p.projectID)&&id(p.scopeID),'Invalid policy identity');
  requireValue(Array.isArray(p.members)&&p.members.length>0&&p.members.length<=100&&p.members.every(m=>exact(m,['principalID','role'])&&id(m.principalID)&&roles.includes(m.role))&&new Set(p.members.map(m=>m.principalID)).size===p.members.length&&p.members.some(m=>m.role==='admin'),'Invalid policy members');
  requireValue(list(p.repositories,repo)&&list(p.branches,x=>x==='ai-team/*'||branch(x)),'Invalid repository/branch allowlist');
  requireValue(list(p.sourcePaths,path)&&list(p.permissions,x=>operations.includes(x))&&Array.isArray(p.sensitivePaths)&&p.sensitivePaths.every(path),'Invalid policy paths/permissions');
  requireValue(exact(p.docker,['images','targets','environments'])&&Array.isArray(p.docker.images)&&p.docker.images.every(image)&&Array.isArray(p.docker.targets)&&p.docker.targets.every(id)&&Array.isArray(p.docker.environments)&&p.docker.environments.every(x=>['development','staging'].includes(x)),'Invalid Docker scope');
  requireValue(exact(p.limits,['timeoutMs','cpuMillis','memoryMiB','concurrency'])&&Object.values(p.limits).every(positive)&&p.limits.timeoutMs<=3600000&&p.limits.concurrency<=32,'Invalid resource limits');
  return p;
}

// One fenced process, protected durable store. authenticate and adapters are trusted injections,
// never RPC payload fields. No real GitHub/Docker adapter is installed by this module.
export function executionGateway({ownerPublicKey,authenticate,load,save,describeSnapshot,adapter,now=Date.now}){
  let tail=Promise.resolve();
  const active=new Map();
  const serial=fn=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;};
  const identity=async context=>{
    const peer=await authenticate(context);
    requireValue(peer&&id(peer.principalID)&&id(peer.projectID)&&['owner',...roles].includes(peer.role),'Authenticated principal required');
    return peer;
  };
  const key=(projectID,scopeID)=>JSON.stringify([projectID,scopeID]);
  const live=(state,projectID,scopeID)=>{
    const scope=state.scopes?.[key(projectID,scopeID)];
    requireValue(scope&&!scope.revoked&&scope.expiresAt>now(),'Scope denied');
    return scope;
  };
  const member=(scope,peer)=>requireValue(scope.policy.members.some(m=>m.principalID===peer.principalID&&m.role===peer.role),'Principal outside scope');
  const audit=(state,event)=>{state.audit??=[];state.audit.push({...event,at:now()});};
  async function stop(jobID){
    active.get(jobID)?.abort();
    let clean=false;
    try{clean=(await adapter.stop(jobID))?.cleaned===true;}catch{/* uncertain until reconciliation */}
    await serial(async()=>{const s=await load(),j=s.jobs?.[jobID];if(j&&j.status==='stopping'){j.status=clean?'stopped':'uncertain';audit(s,{type:'stop',jobID,status:j.status});await save(s);}});
    return clean;
  }
  const api={
    applyOwner:async(context,{decision,signature,policy})=>{
      const peer=await identity(context);
      requireValue(peer.role==='owner','Owner channel required');
      const bytes=Buffer.from(decision),manifest=Buffer.from(policy);
      const d=verifyDecision(bytes,Buffer.from(signature),ownerPublicKey,manifest,now());
      const p=validateExecutionPolicy(JSON.parse(manifest.toString()));
      requireValue(peer.projectID===d.projectID&&p.projectID===d.projectID&&p.scopeID===d.scopeID,'Policy binding mismatch');
      const stopped=await serial(async()=>{
        const s=await load();s.scopes??={};s.nonces??=[];s.jobs??={};
        const k=key(d.projectID,d.scopeID),old=s.scopes[k];
        requireValue(!s.nonces.includes(d.nonce),'Owner decision replay');
        requireValue(d.operation==='approve'?!old&&d.epoch===0:old&&!old.revoked&&d.epoch===old.epoch+1&&old.manifestHash===d.manifestHash,'Scope epoch/binding mismatch');
        s.nonces.push(d.nonce);
        s.scopes[k]={policy:p,manifestHash:d.manifestHash,epoch:d.epoch,expiresAt:d.expiresAt,revoked:d.operation==='revoke'};
        const jobs=[];
        if(d.operation==='revoke')for(const j of Object.values(s.jobs))if(j.projectID===d.projectID&&j.scopeID===d.scopeID&&['running','stopping','uncertain'].includes(j.status)){j.status='stopping';jobs.push(j.id);}
        audit(s,{type:d.operation,scopeID:d.scopeID,projectID:d.projectID});await save(s);return jobs;
      });
      const results=await Promise.all(stopped.map(stop));
      return {revoked:d.operation==='revoke',stopVerified:results.every(Boolean)};
    },
    approve:async(context,request)=>{
      const peer=await identity(context),r=structuredClone(request);
      return serial(async()=>{
        requireValue(peer.role==='admin','Admin approval required');
        requireValue(exact(r,['scopeID','principalID','operation','repository','branch','snapshotHash','image','target','environment','qaReceiptID']),'Invalid operation fields');
        requireValue(id(r.scopeID)&&id(r.principalID)&&operations.includes(r.operation)&&repo(r.repository)&&branch(r.branch)&&hash(r.snapshotHash),'Invalid operation');
        const s=await load(),scope=live(s,peer.projectID,r.scopeID),p=scope.policy;member(scope,peer);
        const worker=p.members.find(m=>m.principalID===r.principalID);
        requireValue(worker&&worker.role!=='admin'&&p.permissions.includes(r.operation),'Operation not delegated');
        requireValue((['edit','commit'].includes(r.operation)&&['frontend','backend'].includes(worker.role))||(r.operation==='test'&&['frontend','backend','devops','qa'].includes(worker.role))||(['push','createPR','dockerBuild','deploy'].includes(r.operation)&&worker.role==='devops'),'Worker role denied');
        requireValue(p.repositories.includes(r.repository)&&p.branches.some(b=>b===r.branch||b==='ai-team/*'),'Repository/branch denied');
        const snapshot=await describeSnapshot(r.snapshotHash);
        requireValue(snapshot&&snapshot.hash===r.snapshotHash&&snapshot.projectID===p.projectID&&snapshot.repository===r.repository&&snapshot.branch===r.branch&&list(snapshot.changedPaths,path)&&snapshot.changedPaths.every(f=>allowedPath(f,p.sourcePaths)&&(!protectedPath(f)||p.sensitivePaths.includes(f))),'Snapshot paths/binding denied');
        requireValue(id(snapshot.authorID)&&(worker.role!=='qa'||snapshot.authorID!==worker.principalID),'Independent QA snapshot required');
        if(['dockerBuild','deploy'].includes(r.operation))requireValue(image(r.image)&&p.docker.images.includes(r.image)&&p.docker.targets.includes(r.target)&&p.docker.environments.includes(r.environment),'Docker scope denied');
        else requireValue(r.image===null&&r.target===null&&r.environment===null,'Unexpected Docker parameters');
        if(['push','createPR','deploy'].includes(r.operation)){
          const qa=s.receipts?.[r.qaReceiptID];
          requireValue(qa&&qa.kind==='qa'&&qa.snapshotHash===r.snapshotHash&&qa.repository===r.repository&&qa.branch===r.branch&&qa.scopeID===r.scopeID&&qa.epoch===scope.epoch&&qa.projectID===peer.projectID&&qa.principalID!==r.principalID,'Independent QA receipt required');
        }else requireValue(r.qaReceiptID===null,'Unexpected receipt');
        const approvalID=randomUUID();s.approvals??={};
        s.approvals[approvalID]={...r,projectID:peer.projectID,epoch:scope.epoch,adminID:peer.principalID,used:false};
        audit(s,{type:'admin-approved',approvalID});await save(s);return {approvalID};
      });
    },
    run:async(context,approvalID)=>{
      const peer=await identity(context);
      const job=await serial(async()=>{
        const s=await load(),a=s.approvals?.[approvalID];
        requireValue(a&&!a.used&&a.principalID===peer.principalID&&a.projectID===peer.projectID,'Approval denied');
        const scope=live(s,peer.projectID,a.scopeID);member(scope,peer);
        requireValue(a.epoch===scope.epoch,'Stale approval');
        requireValue(Object.values(s.jobs??{}).filter(j=>j.projectID===peer.projectID&&j.scopeID===a.scopeID&&['running','stopping','uncertain'].includes(j.status)).length<scope.policy.limits.concurrency,'Concurrency denied');
        a.used=true;const j={...a,id:randomUUID(),role:peer.role,status:'running',limits:scope.policy.limits,deadline:Math.min(scope.expiresAt,now()+scope.policy.limits.timeoutMs)};
        s.jobs??={};s.jobs[j.id]=j;
        // Persist before granting adapter execution; crashes require reconciliation, never replay.
        audit(s,{type:'started',jobID:j.id});await save(s);
        active.set(j.id,new AbortController());return structuredClone(j);
      });
      const controller=active.get(job.id);
      const timer=setTimeout(()=>void serial(async()=>{const s=await load(),j=s.jobs[job.id];if(j.status==='running'){j.status='stopping';await save(s);}}).then(()=>stop(job.id)).catch(()=>{}),Math.max(1,job.deadline-now()));
      try{
        requireValue(!controller.signal.aborted,'Job authority ended');
        // Adapters resolve opaque repository/runner/credential bindings. No commands or tokens in requests.
        const result=await adapter.execute(structuredClone(job),controller.signal);
        return await serial(async()=>{
          const s=await load(),j=s.jobs[job.id];
          const scope=live(s,job.projectID,job.scopeID);
          requireValue(j.status==='running'&&!controller.signal.aborted&&now()<job.deadline&&scope.epoch===job.epoch,'Job authority ended');
          requireValue(result?.success===true&&result.cleaned===true&&hash(result.outputHash),'Adapter success/cleanup unverified');
          j.status='finished';
          const receipt={jobID:j.id,kind:j.operation==='test'&&j.role==='qa'?'qa':'operation',projectID:j.projectID,scopeID:j.scopeID,epoch:j.epoch,principalID:j.principalID,repository:j.repository,branch:j.branch,snapshotHash:j.snapshotHash,operation:j.operation,outputHash:result.outputHash};
          const receiptID=digest(JSON.stringify(receipt));s.receipts??={};s.receipts[receiptID]=receipt;
          audit(s,{type:'finished',jobID:j.id,receiptID});await save(s);return {jobID:j.id,receiptID};
        });
      }catch(error){
        await serial(async()=>{const s=await load(),j=s.jobs[job.id];if(j.status==='running'){j.status='stopping';await save(s);}});
        await stop(job.id);throw error;
      }finally{clearTimeout(timer);active.delete(job.id);}
    },
    reconcile:()=>serial(async()=>{
      const s=await load(),jobs=[];
      for(const j of Object.values(s.jobs??{}))if(['running','stopping','uncertain'].includes(j.status)){
        const scope=s.scopes?.[key(j.projectID,j.scopeID)];
        if(!active.has(j.id)||!scope||scope.revoked||scope.expiresAt<=now()||j.deadline<=now()){j.status='stopping';jobs.push(j.id);}
      }
      await save(s);return jobs;
    }).then(jobs=>Promise.all(jobs.map(stop))),
  };
  return api;
}
