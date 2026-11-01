import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {digest} from '../src/broker.mjs';
import {executionGateway} from '../src/execution-scope.mjs';

const h='a'.repeat(64),outputHash='b'.repeat(64),image='example/build@sha256:'+h;
async function fixture(){
  const keys=generateKeyPairSync('ed25519');let state={},clock=1000;
  const policy={version:1,projectID:'synthetic',scopeID:'scope',members:[{principalID:'admin',role:'admin'},{principalID:'backend',role:'backend'},{principalID:'devops',role:'devops'},{principalID:'qa',role:'qa'}],repositories:['example/synthetic'],branches:['ai-team/*'],sourcePaths:['src','.github'],permissions:['edit','test','commit','push','createPR','dockerBuild','deploy'],sensitivePaths:[],docker:{images:[image],targets:['synthetic-runner'],environments:['staging']},limits:{timeoutMs:5000,cpuMillis:1000,memoryMiB:256,concurrency:1}};
  const snapshot={hash:h,projectID:'synthetic',repository:'example/synthetic',branch:'ai-team/task',changedPaths:['src/Main.java'],authorID:'backend'};
  const calls=[],adapter={execute:async job=>{calls.push(job);return {success:true,cleaned:true,outputHash};},stop:async()=>({cleaned:true})};
  // Object identity represents a fake authenticated transport, not caller-supplied JSON.
  const contexts=new Map(['owner','admin','backend','devops','qa'].map(role=>[{}, {principalID:role,projectID:'synthetic',role}]));
  const ctx=role=>[...contexts].find(([,p])=>p.role===role)[0];
  const gateway=executionGateway({ownerPublicKey:keys.publicKey,authenticate:async c=>contexts.get(c),load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},describeSnapshot:async()=>structuredClone(snapshot),adapter,now:()=>clock});
  const decision=async(operation='approve',p=policy,context=ctx('owner'))=>{
    const manifest=Buffer.from(JSON.stringify(p)),d=Buffer.from(JSON.stringify({operation,projectID:p.projectID,scopeID:p.scopeID,manifestHash:digest(manifest),epoch:operation==='approve'?0:1,nonce:operation+'nonce',expiresAt:10000}));
    return gateway.applyOwner(context,{decision:d,signature:sign(null,d,keys.privateKey),policy:manifest});
  };
  await decision();
  const request=(operation='test',principalID='qa')=>({scopeID:'scope',principalID,operation,repository:'example/synthetic',branch:'ai-team/task',snapshotHash:h,image:null,target:null,environment:null,qaReceiptID:null});
  return {gateway,ctx,policy,snapshot,adapter,calls,decision,request,state:()=>state,time:x=>{clock=x;}};
}

test('Owner delegates once; Admin approves independent QA, push, PR and staging without Owner per command',async()=>{
  const f=await fixture();
  const qa=await f.gateway.approve(f.ctx('admin'),f.request());
  const receipt=await f.gateway.run(f.ctx('qa'),qa.approvalID);
  assert.equal(f.state().receipts[receipt.receiptID].kind,'qa');
  for(const operation of ['push','createPR','deploy']){
    const r={...f.request(operation,'devops'),qaReceiptID:receipt.receiptID};
    if(operation==='deploy')Object.assign(r,{image,target:'synthetic-runner',environment:'staging'});
    const a=await f.gateway.approve(f.ctx('admin'),r);
    await f.gateway.run(f.ctx('devops'),a.approvalID);
    await assert.rejects(f.gateway.run(f.ctx('devops'),a.approvalID),/Approval denied/);
  }
  assert.equal(f.calls.length,4);
});

test('forged identity, expanded policy, repository, branch, paths, secrets and fabricated receipts denied',async()=>{
  const f=await fixture(),g=f.gateway,a=f.ctx('admin');
  await assert.rejects(g.approve({principalID:'admin',role:'admin'},f.request()),/Authenticated/);
  await assert.rejects(f.decision('approve',f.policy,a),/Owner channel/);
  await assert.rejects(f.decision(),/replay/);
  for(const change of [{repository:'other/repo'},{branch:'main'},{branch:'ai-team/../main'},{force:true},{scopeID:'other'}])await assert.rejects(g.approve(a,{...f.request(),...change}));
  for(const changedPaths of [['../escape'],['src2/Main.java'],['.github/workflows/deploy.yml'],['src/.env'],['src/secrets.json']]){
    f.snapshot.changedPaths=changedPaths;await assert.rejects(g.approve(a,f.request()),/Snapshot/);
  }
  f.snapshot.changedPaths=['src/Main.java'];
  await assert.rejects(g.approve(a,{...f.request('push','devops'),qaReceiptID:'forged'}),/QA receipt/);
  await assert.rejects(g.approve(a,{...f.request('deploy','devops'),image,target:'synthetic-runner',environment:'production'}),/Docker scope/);
  f.snapshot.authorID='qa';await assert.rejects(g.approve(a,f.request()),/Independent QA/);
});

test('revoke aborts active fake job, prevents new jobs and suppresses late receipt',async()=>{
  const f=await fixture();let started,finish;
  const ready=new Promise(r=>{started=r;});
  f.adapter.execute=async(job,signal)=>{started(signal);return new Promise(r=>{finish=r;});};
  const a=await f.gateway.approve(f.ctx('admin'),f.request());
  const pending=f.gateway.run(f.ctx('qa'),a.approvalID);const signal=await ready;
  const revoked=await f.decision('revoke');assert.equal(revoked.stopVerified,true);assert.equal(signal.aborted,true);
  await assert.rejects(f.gateway.approve(f.ctx('admin'),f.request()),/Scope denied/);
  finish({success:true,cleaned:true,outputHash});await assert.rejects(pending,/Scope denied|authority ended/);
  assert.equal(Object.keys(f.state().receipts??{}).length,0);
});

test('concurrency, expiry and unverified cleanup fail closed; reconciliation stops orphan jobs',async()=>{
  const f=await fixture();let started,finish;
  const ready=new Promise(r=>{started=r;});
  f.adapter.execute=async()=>{started();return new Promise(r=>{finish=r;});};
  const a=await f.gateway.approve(f.ctx('admin'),f.request()),b=await f.gateway.approve(f.ctx('admin'),f.request());
  const pending=f.gateway.run(f.ctx('qa'),a.approvalID);await ready;
  await assert.rejects(f.gateway.run(f.ctx('qa'),b.approvalID),/Concurrency/);
  f.adapter.stop=async()=>({cleaned:false});f.time(10001);await f.gateway.reconcile();
  assert.equal(Object.values(f.state().jobs)[0].status,'uncertain');
  finish({success:true,cleaned:true,outputHash});await assert.rejects(pending);
  assert.equal(Object.keys(f.state().receipts??{}).length,0);
});
