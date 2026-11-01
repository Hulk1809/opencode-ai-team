import {digest,verifyDecision} from './broker.mjs';
import {brokerOperations,applyExecutionGrant} from './broker-operations.mjs';
// Called only inside a single fenced broker process. All durable mutations serialize;
// execution never holds mutation lock, so revoke can enter while a build waits.
export function brokerControl({ledger,ownerPublicKey,load,save,execute,stopScope,verifyArtifact,operations}){
  let tail=Promise.resolve();
  const serial=fn=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;};
  const active=new Set();
  const operationControl=operations?brokerOperations({load,save,serial,...operations}):null;
  const handlers={
    taskPolicy:(peer,input)=>serial(async()=>{
      if(!['admin','agent'].includes(peer.kind))throw Error('Authenticated task caller required');
      const state=await load(),task=state.tasks?.[JSON.stringify([peer.projectID,input.taskID])];
      if(!task)throw Error('Unknown protected task');
      const scope=state.scopes[JSON.stringify([peer.projectID,task.scopeID])],manifest=JSON.parse(scope?.manifest??'{}');
      if(task.manifestHash!==digest(Buffer.from(scope?.manifest??'')))throw Error('Task policy manifest mismatch');
      if(!manifest.members?.some(m=>m.sessionID===peer.sessionID&&(peer.kind!=='admin'||m.role==='admin')))throw Error('Caller outside task manifest');
      const grant=state.executionGrants?.[JSON.stringify([peer.projectID,task.scopeID])];
      if(grant){if(grant.revoked||grant.expiresAt<=Date.now()||grant.epoch!==task.authorizationEpoch||grant.manifestHash!==task.manifestHash)throw Error('Scope denied');}
      else ledger.authorize(peer.projectID,task.scopeID,task.manifestHash,task.authorizationEpoch);
      return {...task,projectID:peer.projectID,kind:'protected'};
    }),
    submit:(peer,input)=>serial(async()=>{
      const state=await load(),key=JSON.stringify([peer.projectID,peer.sessionID,input.requestID]),hash=digest(JSON.stringify(input));
      const existing=state.requests.find(r=>r.key===key);
      if(existing){if(existing.inputHash!==hash)throw Error('Request ID reused with different input');return {jobID:existing.id,state:existing.state};}
      const scopeKey=JSON.stringify([peer.projectID,input.scopeID]),scope=state.scopes[scopeKey];
      if(!scope)throw Error('Missing approved manifest');
      ledger.authorize(peer.projectID,input.scopeID,digest(Buffer.from(scope.manifest)),input.epoch);
      const manifest=JSON.parse(scope.manifest);
      if(!manifest.members?.some(m=>m.sessionID===peer.sessionID))throw Error('Caller outside manifest');
      const row={key,id:digest(key),inputHash:hash,projectID:peer.projectID,sessionID:peer.sessionID,scopeID:input.scopeID,state:'queued',input,createdAt:Date.now()};
      state.requests.push(row);await save(state);
      const captured={...row,manifest:scope.manifest};
      // Admission is durable before launching; disconnects do not resubmit.
      active.add(row.id);
      queueMicrotask(()=>void run(captured));
      return {jobID:row.id,state:'queued'};
    }),
    status:(peer,input)=>serial(async()=>{
      const row=(await load()).requests.find(r=>r.id===input.jobID&&r.projectID===peer.projectID&&r.sessionID===peer.sessionID);
      if(!row)throw Error('Job not visible');
      const {input:omitted,key,inputHash,...result}=row;return result;
    }),
    view:()=>serial(async()=>({approval:ledger.view(),jobs:(await load()).requests.map(({id,projectID,scopeID,state})=>({id,projectID,scopeID,state}))})),
    completionStatus:(peer,input)=>serial(async()=>{
      if(peer.kind!=='admin'||peer.projectID!==input.projectID)throw Error('Authenticated project Admin required');
      const state=await load(),scope=state.scopes[JSON.stringify([peer.projectID,input.scopeID])],manifest=JSON.parse(scope?.manifest??'{}');
      if(!manifest.members?.some(m=>m.role==='admin'&&m.sessionID===peer.sessionID))throw Error('Admin outside manifest');
      const task=state.tasks?.[JSON.stringify([peer.projectID,input.taskID])];
      if(!task||task.revision!==input.revision||task.snapshotHash!==input.snapshotHash||task.acceptanceEpoch!==input.acceptanceEpoch||task.scopeID!==input.scopeID||task.manifestHash!==digest(Buffer.from(scope.manifest)))throw Error('Task binding superseded');
      ledger.authorize(peer.projectID,input.scopeID,task.manifestHash,input.epoch);
      const result=state.completions?.[JSON.stringify([peer.projectID,input.taskID,input.acceptanceEpoch])]??null;
      if(result&&Object.keys(input).some(key=>result[key]!==input[key]))throw Error('Completion binding mismatch');
      if(result){
        for(const id of [result.buildReceiptID,result.qaReceiptID]){
          const receipt=state.receipts?.[id];
          if(!receipt||digest(JSON.stringify(receipt))!==id)throw Error('Receipt integrity mismatch');
          const row=state.requests.find(r=>r.id===receipt.requestID);
          if(row?.state!=='finished'||row.result?.id!==receipt.buildID)throw Error('Receipt no longer terminal');
          if(!verifyArtifact)throw Error('Protected artifact verifier unavailable');
          for(const artifact of receipt.artifacts)await verifyArtifact(artifact.sha256);
        }
      }
      return result;
    }),
    done:(peer,input)=>serial(async()=>{
      if(peer.kind!=='admin'||peer.projectID!==input.projectID)throw Error('Authenticated project Admin required');
      const state=await load(),receipts=state.receipts??{};
      const scope=state.scopes[JSON.stringify([peer.projectID,input.scopeID])],manifest=JSON.parse(scope?.manifest??'{}');
      const task=manifest.tasks?.find(t=>t.taskID===input.taskID);
      if(!manifest.members?.some(m=>m.role==='admin'&&m.sessionID===peer.sessionID)||!task||task.revision!==input.revision||task.snapshotHash!==input.snapshotHash||task.acceptanceEpoch!==input.acceptanceEpoch)throw Error('Authoritative task binding mismatch');
      const authoritative=state.tasks?.[JSON.stringify([peer.projectID,input.taskID])];
      if(!authoritative||authoritative.manifestHash!==digest(Buffer.from(scope.manifest))||authoritative.scopeID!==input.scopeID||authoritative.acceptanceEpoch!==input.acceptanceEpoch)throw Error('Task scope superseded');
      const build=receipts[input.buildReceiptID],qa=receipts[input.qaReceiptID];
      if(!build||!qa||digest(JSON.stringify(build))!==input.buildReceiptID||digest(JSON.stringify(qa))!==input.qaReceiptID)throw Error('Receipt integrity mismatch');
      if(!build||!qa||build.kind!=='build'||qa.kind!=='qa'||qa.parentBuildID!==build.buildID||qa.sessionID===build.sessionID)throw Error('Trusted independent receipts required');
      for(const receipt of [build,qa]){
        if(receipt.projectID!==input.projectID||receipt.taskID!==input.taskID||receipt.snapshotHash!==input.snapshotHash||receipt.epoch!==input.epoch||receipt.scopeID!==input.scopeID)throw Error('Receipt binding mismatch');
        if(receipt.revision!==task.revision||receipt.acceptanceEpoch!==task.acceptanceEpoch)throw Error('Stale task receipt');
        ledger.authorize(receipt.projectID,receipt.scopeID,receipt.manifestHash,receipt.epoch);
        const row=state.requests.find(r=>r.id===receipt.requestID);
        if(row?.state!=='finished'||row.result?.id!==receipt.buildID)throw Error('Receipt no longer terminal');
      }
      if(build.goal!==qa.goal||build.manifestHash!==qa.manifestHash||!build.artifacts.length||digest(JSON.stringify(build.artifacts))!==digest(JSON.stringify(qa.artifacts)))throw Error('Artifact mismatch or missing artifacts');
      if(!verifyArtifact)throw Error('Protected artifact verifier unavailable');
      for(const artifact of build.artifacts)await verifyArtifact(artifact.sha256);
      const key=JSON.stringify([input.projectID,input.taskID,input.acceptanceEpoch]);
      state.completions??={};
      if(state.completions[key]||Object.values(state.completions).some(c=>c.buildReceiptID===input.buildReceiptID||c.qaReceiptID===input.qaReceiptID))throw Error('Completion replay');
      const completion={...input,completionID:digest(JSON.stringify([input.projectID,input.taskID,input.revision,input.acceptanceEpoch])),adminSessionID:peer.sessionID,completedAt:Date.now()};state.completions[key]=completion;await save(state);return completion;
    }),
  };
  const decision=operation=>(peer,input)=>serial(async()=>{
    if(peer.kind!=='owner')throw Error('Owner channel required');
    const bytes=Buffer.from(input.decision,'base64'),sig=Buffer.from(input.signature,'base64'),manifest=Buffer.from(input.manifest,'base64');
    const d=verifyDecision(bytes,sig,ownerPublicKey,manifest);
    if(d.operation!==operation)throw Error('Decision operation mismatch');
    const m=JSON.parse(manifest.toString());
    if(m.projectID!==d.projectID||m.scopeID!==d.scopeID)throw Error('Manifest identity mismatch');
    const state=await load(),key=JSON.stringify([d.projectID,d.scopeID]);
    if(m.executionPolicy||m.version===2){
      if(!operationControl)throw Error('Execution operations unavailable');
      const copy=structuredClone(state);
      if(!applyExecutionGrant(copy,m,d))return {projectID:d.projectID,scopeID:d.scopeID,operation};
      if(operation==='approve'){
        const seen=new Set();
        for(const task of m.tasks??[]){
          const old=copy.tasks?.[JSON.stringify([d.projectID,task.taskID])];
          if(typeof task.taskID!=='string'||!task.taskID||seen.has(task.taskID)||typeof task.revision!=='string'||!task.revision||!/^[a-f0-9]{64}$/.test(task.snapshotHash)||!Number.isSafeInteger(task.acceptanceEpoch)||task.acceptanceEpoch<0||old&&task.acceptanceEpoch<=old.acceptanceEpoch)throw Error('Task binding invalid or acceptance epoch not advanced');
          seen.add(task.taskID);
        }
        if(copy.scopes[key])throw Error('Scope already bound');
        copy.scopes[key]={manifest:manifest.toString()};copy.tasks??={};
        for(const task of m.tasks??[])copy.tasks[JSON.stringify([d.projectID,task.taskID])]={...task,scopeID:d.scopeID,manifestHash:d.manifestHash,authorizationEpoch:d.epoch};
      }
      // Single atomic store save includes grant/nonce/task/audit. Never write legacy ledger.
      await save(copy);
      return {projectID:d.projectID,scopeID:d.scopeID,operation};
    }
    if(state.executionGrants?.[key])throw Error('Versioned execution scope cannot use legacy authority');
    if(operation==='approve'){
      const seen=new Set();
      for(const task of m.tasks??[]){
        const old=state.tasks?.[JSON.stringify([d.projectID,task.taskID])];
        if(typeof task.taskID!=='string'||!task.taskID||seen.has(task.taskID)||typeof task.revision!=='string'||!task.revision||!/^[a-f0-9]{64}$/.test(task.snapshotHash)||!Number.isSafeInteger(task.acceptanceEpoch)||task.acceptanceEpoch<0||old&&task.acceptanceEpoch<=old.acceptanceEpoch)throw Error('Task binding invalid or acceptance epoch not advanced');
        seen.add(task.taskID);
      }
    }
    await ledger.apply(bytes,sig,manifest);
    if(operation==='approve'){
      state.scopes[key]={manifest:manifest.toString()};state.tasks??={};
      for(const task of m.tasks??[])state.tasks[JSON.stringify([d.projectID,task.taskID])]={...task,scopeID:d.scopeID,manifestHash:d.manifestHash,authorizationEpoch:d.epoch};
    }
    else for(const row of state.requests)if(row.projectID===d.projectID&&row.scopeID===d.scopeID&&['queued','running','uncertain'].includes(row.state)){row.state='stopping';row.stopReason='revoked';}
    await save(state);
    if(operation==='revoke')await finishStop(d.projectID,d.scopeID,'revoked');
    return {projectID:d.projectID,scopeID:d.scopeID,operation};
  });
  handlers.approve=decision('approve');handlers.revoke=decision('revoke');
  if(operationControl)Object.assign(handlers,operationControl.handlers);
  // Sweep outside control serialization so stop/completion can acquire the same fence.
  if(operationControl){const revoke=handlers.revoke;handlers.revoke=async(...args)=>{const result=await revoke(...args);await operationControl.sweep();return result;};}
  // Caller must serialize this operation. Never report revoked/expired until stop verifies.
  async function finishStop(projectID,scopeID,terminal){
    let error;try{await stopScope(projectID,scopeID);}catch(e){error=e;}
    const state=await load();
    for(const row of state.requests)if(row.projectID===projectID&&row.scopeID===scopeID&&row.state==='stopping'){
      row.state=error?'uncertain':terminal;row.stopReason=terminal;row.error=error?'Scope stop unverified; reconciliation required':null;
    }
    await save(state);if(error)throw error;
  }
  const expire=()=>serial(async()=>{
    const state=await load(),scopes=new Map();
    for(const row of state.requests)if(['uncertain','stopping'].includes(row.state)&&row.stopReason){row.state='stopping';scopes.set(JSON.stringify([row.projectID,row.scopeID]),row);}
    for(const row of state.requests)if(['queued','running'].includes(row.state)){
      const scope=state.scopes[JSON.stringify([row.projectID,row.scopeID])];
      try{ledger.authorize(row.projectID,row.scopeID,digest(Buffer.from(scope?.manifest??'')),row.input.epoch);}
      catch{row.state='stopping';row.stopReason='expired';scopes.set(JSON.stringify([row.projectID,row.scopeID]),row);}
    }
    await save(state);
    for(const row of scopes.values())await finishStop(row.projectID,row.scopeID,row.stopReason);
  });
  async function run(row){
    let allowed=false;
    await serial(async()=>{const state=await load(),r=state.requests.find(r=>r.id===row.id);if(r.state!=='queued')return;r.state='running';await save(state);active.add(row.id);allowed=true;});
    if(!allowed){active.delete(row.id);return;}
    let result,error;
    try{ledger.authorize(row.projectID,row.scopeID,digest(Buffer.from(row.manifest)),row.input.epoch);result=await execute(row);}catch(e){error=e.message;}
    await serial(async()=>{const state=await load(),r=state.requests.find(r=>r.id===row.id);if(r.state==='running'){try{ledger.authorize(row.projectID,row.scopeID,digest(Buffer.from(row.manifest)),row.input.epoch);}catch{error='Scope denied before completion';}r.state=error?'blocked':'finished';r.error=error??null;r.result=error?null:result??null;
      if(!error&&result?.state==='succeeded'&&result.cleanedAt&&result.exitCode===0&&Array.isArray(result.artifacts)){
        const task=JSON.parse(row.manifest).tasks?.find(t=>t.taskID===row.input.taskID);
        const receipt={kind:row.input.buildID?'qa':'build',projectID:row.projectID,scopeID:row.scopeID,taskID:row.input.taskID,requestID:row.id,buildID:result.id,parentBuildID:row.input.buildID??null,sessionID:row.sessionID,snapshotHash:result.snapshotHash,revision:task?.revision,acceptanceEpoch:task?.acceptanceEpoch,manifestHash:digest(Buffer.from(row.manifest)),epoch:row.input.epoch,goal:row.input.goal,artifacts:result.artifacts,outputHash:result.outputHash};
        if(!row.input.buildID||result.role==='qa'){state.receipts??={};const receiptID=digest(JSON.stringify(receipt));state.receipts[receiptID]=receipt;r.result.receiptID=receiptID;}
      }
    }r.completedAt=Date.now();await save(state);active.delete(row.id);});
  }
  const shutdown=()=>serial(async()=>{
    const state=await load(),scopes=new Map();
    for(const row of state.requests)if(['queued','running','stopping','uncertain'].includes(row.state)){
      row.state='stopping';row.stopReason='interrupted';scopes.set(JSON.stringify([row.projectID,row.scopeID]),row);
    }
    await save(state);for(const row of scopes.values())await finishStop(row.projectID,row.scopeID,'interrupted');
  });
  return {handlers,operations:operationControl,expire:async()=>{await expire();await operationControl?.sweep();},shutdown,recover:async()=>{await serial(async()=>{const state=await load();for(const row of state.requests)if(['queued','running','stopping'].includes(row.state))row.state='uncertain';await save(state);});await operationControl?.recover();},idle:async()=>{while(active.size)await new Promise(r=>setImmediate(r));await tail;}};
}
