import {randomUUID} from 'node:crypto';
import {digest} from './broker.mjs';
import {validateExecutionPolicy} from './execution-scope.mjs';
import {verifySourceEvidence} from './qa-evidence.mjs';
import {claimLease,endLease} from './broker-leases.mjs';

export const canonical=value=>JSON.stringify(normalize(value));
function normalize(value){
  if(Array.isArray(value))return value.map(normalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])]));
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return value;
  throw Error('Invalid canonical input');
}
const check=(ok,message)=>{if(!ok)throw Error(message);};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const binding=['projectID','taskID','scopeID','authorizationEpoch','acceptanceEpoch','revision','snapshotHash','repository','repositoryID','branch','baseCommit'];
const same=(a,b,keys)=>keys.every(k=>a[k]===b[k]);
export const operationFields=['requestID','taskID','scopeID','authorizationEpoch','acceptanceEpoch','revision','snapshotHash','repository','repositoryID','branch','baseCommit','operation','workerSessionID','image','target','environment','qaReceiptID'];
const fields=operationFields;
const audit=(s,type,data)=>{s.operationAudit??=[];s.operationAudit.push({seq:s.operationAudit.length+1,type,...data});};
const publicRow=row=>structuredClone(row);

// Runs inside broker-control's serialization fence and the same protected state store.
// Adapters are trusted injections, never native RPC or worker supplied code.
export function brokerOperations({load,save,serial,adapter,describeSnapshot,verifyEvidence,writeProposal,leasePolicy,protectedSource=false,now=Date.now}){
  let ready=false;
  const persist=save;
  save=async state=>{try{await persist(state);}catch(error){ready=false;throw error;}};
  const active=new Map();
  async function source(row){
    const snap=await describeSnapshot(row.snapshotHash);
    check(snap&&same(snap,row,['projectID','taskID','revision','snapshotHash','repository','repositoryID','branch','baseCommit']),'Snapshot binding denied');
    if(protectedSource)check(snap.kind==='protected-source'&&snap.acceptanceEpoch===row.acceptanceEpoch&&hash(snap.sourceHash)&&(!row.sourceHash||row.sourceHash===snap.sourceHash),'Protected source binding denied');
    return snap;
  }
  const scope=(s,peer,scopeID)=>{
    const g=s.executionGrants?.[JSON.stringify([peer.projectID,scopeID])];
    check(g&&!g.revoked&&g.expiresAt>now(),'Execution scope denied');
    check(g.manifest.members.some(m=>m.sessionID===peer.sessionID&&m.role===peer.role),'Authenticated member required');
    return g;
  };
  const valid=(s,row)=>{
    const g=s.executionGrants?.[JSON.stringify([row.projectID,row.scopeID])],t=s.tasks?.[JSON.stringify([row.projectID,row.taskID])];
    check(g&&!g.revoked&&g.expiresAt>now()&&g.epoch===row.authorizationEpoch&&g.manifestHash===row.manifestHash,'Execution scope denied');
    check(t&&same(t,row,['scopeID','revision','snapshotHash','acceptanceEpoch','authorizationEpoch'])&&t.manifestHash===row.manifestHash,'Task binding superseded');
    return g;
  };
  async function cleanup(row){
    active.get(row.operationID)?.abort();
    let verified=false;
    try{const proof=await adapter.stop(publicRow(row));verified=await verifyEvidence(row,proof, 'stopped');if(leasePolicy)verified=verified===true&&await leasePolicy.verifyQuiescence(row,proof)===true;}catch{/* preserve uncertainty */}
    await serial(async()=>{const s=await load(),r=s.operations[row.operationID];if(r.status==='stopping'||r.status==='uncertain'){r.status=verified===true?'stopped':'uncertain';if(leasePolicy)endLease(s,r,verified===true);audit(s,'cleanup',{operationID:r.operationID,status:r.status});await save(s);}});
  }
  const handlers={
    operationProposal:(peer,{operationID,generation,files})=>serial(async()=>{
      check(ready&&protectedSource&&writeProposal,'Protected writer unavailable');
      const s=await load(),r=s.operations?.[operationID];
      check(r&&r.operation==='edit'&&r.status==='admitted'&&peer.kind==='agent'&&peer.projectID===r.projectID&&peer.sessionID===r.workerSessionID&&peer.role===r.workerRole&&r.workerPrincipalID===(peer.principalID??peer.sessionID),'Proposal worker denied');
      const requestHash=digest(canonical({generation,files}));
      if(r.proposal){check(r.proposalHash===requestHash,'Proposal retry mismatch');return publicRow(r);}
      valid(s,r);check(generation===r.writerGeneration,'Stale writer generation');
      check(Number.isSafeInteger(generation)&&Array.isArray(files)&&files.length<=2000&&Buffer.byteLength(canonical(files))<=24*1024*1024,'Invalid bounded proposal');
      // Persist proposal in same broker transaction. No canonical filesystem path supplied.
      r.proposal=structuredClone(files);r.proposalHash=requestHash;audit(s,'proposal',{operationID,generation});await save(s);return publicRow(r);
    }),
    operationApprove:(peer,input)=>serial(async()=>{
      check(ready,'Operation admission closed');
      check(peer.kind==='admin'&&peer.role==='admin'&&id(peer.sessionID)&&id(peer.projectID),'Authenticated Admin required');
      check(input&&Object.keys(input).sort().join(',')===[...fields].sort().join(','),'Invalid operation fields');
      const r=structuredClone(input);
      check([r.requestID,r.taskID,r.scopeID,r.workerSessionID].every(id)&&hash(r.snapshotHash)&&/^[a-f0-9]{40}$/.test(r.baseCommit)&&typeof r.repositoryID==='string'&&/^[1-9][0-9]*$/.test(r.repositoryID),'Invalid operation identity');
      const s=await load(),g=scope(s,peer,r.scopeID),p=g.manifest.executionPolicy;
      const operationID=digest(canonical(['broker-operation-v1',peer.projectID,r.taskID,peer.sessionID,r.requestID])),requestHash=digest(canonical(r));
      s.operations??={};const old=s.operations[operationID];
      if(old){check(old.adminPrincipalID===(peer.principalID??peer.sessionID),'Authenticated principal mismatch');check(old.requestHash===requestHash,'Request ID payload mismatch');return publicRow(old);}
      const row={...r,operationID,requestHash,projectID:peer.projectID,manifestHash:g.manifestHash,adminSessionID:peer.sessionID,adminPrincipalID:peer.principalID??peer.sessionID,attemptID:randomUUID(),decisionID:digest(canonical([operationID,requestHash])),status:'approved'};
      valid(s,row);
      const worker=g.manifest.members.find(m=>m.sessionID===r.workerSessionID);
      check(worker&&p.members.some(m=>m.principalID===worker.sessionID&&m.role===worker.role),'Worker outside policy');
      const allowed={edit:['frontend','backend'],commit:['frontend','backend'],test:['frontend','backend','devops','qa'],push:['devops'],createPR:['devops'],dockerBuild:['devops'],deploy:['devops']};
      check(p.permissions.includes(r.operation)&&allowed[r.operation]?.includes(worker.role),'Operation not delegated');
      check(p.repositories.includes(r.repository)&&typeof r.branch==='string'&&/^ai-team\/[A-Za-z0-9_/-]+$/.test(r.branch)&&!r.branch.includes('//')&&!r.branch.endsWith('/')&&p.branches.some(b=>b===r.branch||b==='ai-team/*'),'Repository/branch denied');
      check(describeSnapshot&&adapter&&verifyEvidence,'Operation adapters unavailable');
      const snap=await source(row);
      check(snap&&same(snap,row,['projectID','taskID','revision','snapshotHash','repository','repositoryID','branch','baseCommit'])&&id(snap.authorSessionID)&&Array.isArray(snap.changedPaths)&&snap.changedPaths.length>0,'Snapshot binding denied');
      check(snap.changedPaths.every(f=>typeof f==='string'&&f.split('/').every(c=>/^[A-Za-z0-9_.-]+$/.test(c)&&c!=='.'&&c!=='..')&&!f.includes('\\')&&!f.split('/').some(c=>/^\.github$|^\.env(?:\.|$)|^(?:secret|credential)s?(?:\.|$)/i.test(c))&&p.sourcePaths.some(root=>f===root||f.startsWith(root+'/'))),'Snapshot path denied');
      check(worker.role!=='qa'||snap.authorSessionID!==worker.sessionID,'Independent QA required');
      if(['dockerBuild','deploy'].includes(r.operation))check(p.docker.images.includes(r.image)&&p.docker.targets.includes(r.target)&&p.docker.environments.includes(r.environment)&&r.environment==='staging','Docker scope denied');
      else check(r.image===null&&r.target===null&&r.environment===null,'Unexpected Docker fields');
      if(['push','createPR','deploy'].includes(r.operation)){
        const receipt=s.operationReceipts?.[r.qaReceiptID],qa=receipt&&s.operations[receipt.operationID];
        check(receipt&&digest(canonical(receipt))===r.qaReceiptID&&qa?.status==='succeeded'&&receipt.kind==='qa'&&same(receipt,row,binding)&&receipt.workerSessionID!==worker.sessionID&&(!protectedSource||receipt.sourceHash===snap.sourceHash),'Current independent QA receipt required');
      }else check(r.qaReceiptID===null,'Unexpected QA receipt');
      if(protectedSource)row.sourceHash=snap.sourceHash;
      row.workerRole=worker.role;row.authorSessionID=snap.authorSessionID;row.limits={...p.limits,sourcePaths:p.sourcePaths};
      s.operations[operationID]=row;audit(s,'approved',{operationID,decisionID:row.decisionID});await save(s);return publicRow(row);
    }),
    operationStatus:(peer,{operationID})=>serial(async()=>{
      const s=await load(),r=s.operations?.[operationID];
      check(r&&r.projectID===peer.projectID&&((peer.kind==='admin'&&peer.role==='admin'&&r.adminSessionID===peer.sessionID&&r.adminPrincipalID===(peer.principalID??peer.sessionID))||(peer.kind==='agent'&&peer.sessionID===r.workerSessionID&&peer.role===r.workerRole&&(!r.workerPrincipalID||r.workerPrincipalID===(peer.principalID??peer.sessionID)))),'Operation not visible');
      return publicRow(r);
    }),
    operationAdmit:(peer,{operationID})=>serial(async()=>{
      check(ready,'Operation admission closed');
      const s=await load(),r=s.operations?.[operationID];
      check(r&&peer.kind==='agent'&&r.projectID===peer.projectID&&r.workerSessionID===peer.sessionID&&r.workerRole===peer.role,'Authenticated worker required');
      check(!r.workerPrincipalID||r.workerPrincipalID===(peer.principalID??peer.sessionID),'Authenticated principal mismatch');
      if(r.status!=='approved')return publicRow(r);
      const g=valid(s,r);
      if(protectedSource)await source(r);
      if(protectedSource&&r.operation==='edit'){
        const t=s.tasks[JSON.stringify([r.projectID,r.taskID])];t.writerGeneration=(t.writerGeneration??0)+1;r.writerGeneration=t.writerGeneration;
      }
      check(!Object.values(s.operations).some(x=>x.projectID===r.projectID&&x.scopeID===r.scopeID&&['uncertain','stopping'].includes(x.status)),'Unreconciled scope blocks admission');
      check(Object.values(s.operations).filter(x=>x.projectID===r.projectID&&x.scopeID===r.scopeID&&['admitted','preflight','effect_pending','stopping','uncertain'].includes(x.status)).length<g.manifest.executionPolicy.limits.concurrency,'Concurrency denied');
      if(leasePolicy){const lease=claimLease(s,r,await leasePolicy.resource(r));r.leaseGeneration=lease.generation;}
      r.workerPrincipalID=peer.principalID??peer.sessionID;r.deadline=Math.min(g.expiresAt,now()+r.limits.timeoutMs);r.status='admitted';audit(s,'admitted',{operationID});await save(s);return publicRow(r);
    }),
  };
  // Internal scheduler only: never expose this method as an unauthenticated RPC.
  async function execute(operationID){
    check(ready,'Operation admission closed');
    const controller=new AbortController();
    const row=await serial(async()=>{
      const s=await load(),r=s.operations?.[operationID];check(r?.status==='admitted'&&!active.has(operationID),'Operation not executable');valid(s,r);
      if(leasePolicy)check(s.operationLeases?.[operationID]?.state==='ACTIVE'&&s.operationLeases[operationID].generation===r.leaseGeneration,'Lease fence mismatch');
      if(protectedSource&&r.operation==='edit')check(s.tasks[JSON.stringify([r.projectID,r.taskID])].writerGeneration===r.writerGeneration,'Stale writer generation');
      check(r.deadline>now(),'Operation expired');active.set(operationID,controller);r.status='preflight';audit(s,'preflight',{operationID});
      try{await save(s);}catch(e){active.delete(operationID);throw e;}return publicRow(r);
    });
    let timer;
    try{
      timer=setTimeout(()=>{controller.abort();void sweep().catch(()=>{});},Math.max(1,row.deadline-now()));
      if(protectedSource)await source(row);
      const preflight=await adapter.preflight(row,controller.signal);
      check(await verifyEvidence(row,preflight,'preflight')===true,'Preflight unverified');
      await serial(async()=>{const s=await load(),r=s.operations[operationID];valid(s,r);if(protectedSource)await source(r);check(r.status==='preflight'&&!controller.signal.aborted&&r.deadline>now(),'Operation cancelled');r.status='effect_pending';audit(s,'effect-intent',{operationID,attemptID:r.attemptID});await save(s);});
      const result=protectedSource&&row.operation==='edit'?(check(Array.isArray(row.proposal),'Protected proposal required'),await writeProposal(row,row.proposal)):null;
      const evidence=await adapter.execute({...row,...(result?{writerResult:result}:{})},controller.signal);
      if(result)check(evidence.resultSnapshotHash===result.resultSnapshotHash&&evidence.resultRevision===result.resultRevision,'Writer result mismatch');
      check(await verifyEvidence(row,evidence,'terminal')===true,'Terminal evidence unverified');
      if(leasePolicy)check(await leasePolicy.verifyQuiescence(row,evidence)===true,'Quiescence unverified');
      if(protectedSource&&row.workerRole==='qa')await verifySourceEvidence({row,evidence,snapshot:await source(row),verifyAdapter:verifyEvidence});
      if(row.operation==='edit'){
        const result=await describeSnapshot(evidence.resultSnapshotHash);
        check(result&&same(result,row,['projectID','taskID','repository','repositoryID','branch','baseCommit'])&&result.snapshotHash===evidence.resultSnapshotHash&&result.revision===evidence.resultRevision&&result.authorSessionID===row.workerSessionID,'Edit result snapshot unverified');
        if(protectedSource){
          check(result.kind==='protected-source'&&result.acceptanceEpoch===row.acceptanceEpoch+1&&result.revision!==row.revision,'Edit source epoch denied');
          const s=await load(),p=valid(s,row).manifest.executionPolicy;
          check(result.changedPaths.every(f=>!f.split('/').some(c=>/^\.github$|^\.env(?:\.|$)|^(?:secret|credential)s?(?:\.|$)/i.test(c))&&p.sourcePaths.some(root=>f===root||f.startsWith(root+'/'))),'Edit source diff denied');
        }
      }
      return await serial(async()=>{
        const s=await load(),r=s.operations[operationID];valid(s,r);if(protectedSource)await source(r);check(r.status==='effect_pending'&&!controller.signal.aborted&&r.deadline>now(),'Operation cancelled');
        check(hash(evidence.outputHash)&&evidence.cleaned===true,'Result/cleanup unverified');
        if(row.operation==='edit')check(hash(evidence.resultSnapshotHash)&&evidence.resultSnapshotHash!==row.snapshotHash&&typeof evidence.resultRevision==='string'&&evidence.resultRevision!==row.revision,'Edit must produce new revision');
        const receipt={...Object.fromEntries(binding.map(k=>[k,r[k]])),operationID,attemptID:r.attemptID,decisionID:r.decisionID,workerSessionID:r.workerSessionID,kind:r.operation==='test'&&r.workerRole==='qa'?'qa':'operation',outputHash:evidence.outputHash,evidenceHash:digest(canonical(evidence))};
        if(protectedSource){receipt.sourceHash=r.sourceHash;receipt.workerPrincipalID=r.workerPrincipalID;}
        const receiptID=digest(canonical(receipt));s.operationReceipts??={};s.operationReceipts[receiptID]=receipt;r.status='succeeded';r.receiptID=receiptID;
        if(r.operation==='edit'){
          const t=s.tasks[JSON.stringify([r.projectID,r.taskID])];if(protectedSource)check(t.writerGeneration===r.writerGeneration,'Stale writer generation');t.snapshotHash=evidence.resultSnapshotHash;t.revision=evidence.resultRevision;t.acceptanceEpoch++;
          r.resultSnapshotHash=t.snapshotHash;r.resultRevision=t.revision;
        }
        if(leasePolicy)endLease(s,r,true);
        audit(s,'succeeded',{operationID,receiptID});await save(s);return publicRow(r);
      });
    }catch(error){
      await serial(async()=>{const s=await load(),r=s.operations[operationID];if(r.status!=='succeeded'){r.status='uncertain';audit(s,'uncertain',{operationID});await save(s);}});
      await cleanup(row);throw error;
    }finally{clearTimeout(timer);active.delete(operationID);}
  }
  async function sweep(recover=false){
    if(recover)ready=false;
    if(recover&&protectedSource){
      const s=await load();
      for(const [key,t] of Object.entries(s.tasks??{})){
        const [projectID,taskID]=JSON.parse(key),g=s.executionGrants?.[JSON.stringify([projectID,t.scopeID])];
        if(g&&!g.revoked){const snap=await describeSnapshot(t.snapshotHash);check(snap.projectID===projectID&&snap.taskID===taskID&&snap.revision===t.revision&&snap.acceptanceEpoch===t.acceptanceEpoch,'Recovered source binding denied');}
      }
    }
    const rows=await serial(async()=>{
      const s=await load(),rows=[];
      for(const r of Object.values(s.operations??{})){
        let invalid=false;try{valid(s,r);}catch{invalid=true;}
        if(r.status==='approved'&&invalid){r.status='cancelled';audit(s,'cancelled',{operationID:r.operationID});}
        if(['admitted','preflight','effect_pending','stopping','uncertain'].includes(r.status)&&(recover||invalid||r.deadline<=now()||['stopping','uncertain'].includes(r.status))){r.status='uncertain';rows.push(publicRow(r));audit(s,'reconcile',{operationID:r.operationID});}
      }
      await save(s);return rows;
    });
    for(const row of rows)await cleanup(row);
    if(recover){const s=await load();check(!Object.values(s.operations??{}).some(r=>['uncertain','stopping'].includes(r.status)),'Unreconciled operations block admission');ready=true;}
  }
  return {handlers,execute,sweep,recover:()=>sweep(true),close:async()=>{ready=false;try{await sweep(true);}finally{ready=false;}}};
}

export function applyExecutionGrant(state,manifest,decision){
  check(manifest.version===2&&manifest.executionPolicy,'Unsupported execution manifest');
  const p=validateExecutionPolicy(manifest.executionPolicy);
  check(p.projectID===decision.projectID&&p.scopeID===decision.scopeID,'Execution policy binding mismatch');
  check(Array.isArray(manifest.members)&&manifest.members.every(m=>id(m.sessionID)&&p.members.some(x=>x.principalID===m.sessionID&&x.role===m.role)),'Execution member mismatch');
  state.executionGrants??={};state.executionNonces??=[];
  const key=JSON.stringify([decision.projectID,decision.scopeID]),old=state.executionGrants[key];
  if(old?.decisionHash===digest(canonical(decision)))return false;
  check(!state.executionNonces.includes(decision.nonce),'Execution decision replay');
  check(decision.operation==='approve'?!old&&decision.epoch===0:old&&!old.revoked&&decision.epoch===old.epoch+1&&old.manifestHash===decision.manifestHash,'Execution epoch mismatch');
  state.executionNonces.push(decision.nonce);
  state.executionGrants[key]={manifest,manifestHash:decision.manifestHash,expiresAt:decision.expiresAt,epoch:decision.epoch,revoked:decision.operation==='revoke',decisionHash:digest(canonical(decision))};
  audit(state,decision.operation,{projectID:decision.projectID,scopeID:decision.scopeID,epoch:decision.epoch});return true;
}
