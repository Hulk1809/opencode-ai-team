import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {brokerStore} from '../src/broker-store.mjs';
import {application,certificates,loadCertificates,send,disconnect} from './fixtures/operation-http-harness.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};

test('Phase1.7 isolated protected HTTP/mTLS integration',async t=>{
  const root=await mkdtemp('/tmp/opencode/operation-http-'),apps=[];t.after(async()=>{for(const app of apps)await app.close();await rm(root,{recursive:true,force:true});});
  await certificates(root);const certs=await loadCertificates(root);
  async function setup(options={}){const dir=await mkdtemp(`${root}/state-`),f=await application(dir,certs,options);apps.push(f);f.http=(name,path,input)=>send(certs,f.port,name,path,input);return f;}
  async function owner(f){assert.equal((await f.http('owner','/approve',f.signed('approve'))).status,200);}
  async function approve(f,input=f.request()){const r=await f.http('admin','/v1/operations/approve',input);assert.equal(r.status,200);return r.output;}
  async function execute(f,row){assert.equal((await f.http(row.workerSessionID,'/v1/operations/admit',{operationID:row.operationID})).status,200);await f.runtime.operations.execute(row.operationID);const r=await f.http(row.workerSessionID,'/v1/operations/status',{operationID:row.operationID});assert.equal(r.status,200);return r.output;}

  await t.test('Owner, Admin, build, independent QA, push and receipt traverse real service/runtime transport',async()=>{
    const f=await setup();await owner(f);
    const build=await execute(f,await approve(f,f.request('build','test','backend')));assert.equal(build.status,'succeeded');
    const qa=await execute(f,await approve(f,f.request('qa')));
    const pushed=await execute(f,await approve(f,{...f.request('push','push','devops'),qaReceiptID:qa.receiptID}));
    assert.equal(pushed.status,'succeeded');assert.equal(pushed.adminPrincipalID,'principal_admin');assert.equal(pushed.workerPrincipalID,'principal_devops');assert.equal(f.calls.length,3);
    const s=await f.store.load();assert.equal(s.operationReceipts[pushed.receiptID].operationID,pushed.operationID);
    assert.equal((await f.http('admin','/v1/operations/status',{operationID:pushed.operationID})).status,200);
    for(const [name,path,input,status] of [
      ['unknown','/v1/operations/approve',f.request(),400],['outsider','/v1/operations/admit',{operationID:pushed.operationID},409],
      ['backend','/v1/operations/status',{operationID:pushed.operationID},409],['qa','/v1/operations/approve',f.request(),403],
      ['admin','/approve',f.signed('approve'),403],['backend','/revoke',f.signed('revoke'),403],
      ['owner','/v1/operations/admit',{operationID:pushed.operationID},403],['admin','/v2/operations/approve',f.request(),400],
      ['qa','/v1/operations/evidence',{PASS:true},400],['admin','/v1/operations/approve',{...f.request(),projectID:'other'},400],
      ['admin','/v1/operations/approve',{...f.request(),role:'owner'},400],['admin','/v1/operations/approve',{...f.request(),sessionID:'owner'},400],
      ['admin','/v1/operations/approve',{...f.request('forged','push','devops'),qaReceiptID:'fake'},409],
      ['admin','/v1/operations/approve',{...f.request('stale','push','devops'),revision:'r0',qaReceiptID:qa.receiptID},409],
      ['admin','/v1/operations/approve',{...f.request('bad'),operation:'shell'},409],
    ])assert.equal((await f.http(name,path,input)).status,status,`${name} ${path}`);
    f.manifest.projectID='other';f.manifest.executionPolicy.projectID='other';assert.equal((await f.http('owner','/approve',f.signed('approve'))).status,403);
  });

  await t.test('production defaults keep versioned operation routes disabled',async()=>{
    const f=await setup({isolatedOperations:false});assert.equal((await f.http('admin','/v1/operations/approve',f.request())).status,400);
  });

  await t.test('lost HTTP Owner grant response retries same signed decision once',async()=>{
    const f=await setup(),envelope=f.signed('approve');
    await send(certs,f.port,'owner','/approve',envelope,{dropResponse:true});
    assert.equal((await f.http('owner','/approve',envelope)).status,200);
    assert.equal((await f.store.load()).operationAudit.filter(x=>x.type==='approve').length,1);
  });

  for(const point of ['before-rename','after-rename'])await t.test(`network admission, SIGKILL ${point}, fresh service recovery, no replay`,{timeout:15000},async()=>{
    const directory=await mkdtemp(`${root}/crash-`);
    const child=fork(new URL('./fixtures/operation-http-crash-child.mjs',import.meta.url),[root,directory,point],{stdio:['ignore','ignore','pipe','ipc']});
    try{
      const [ready]=await once(child,'message');
      assert.equal((await send(certs,ready.port,'owner','/approve',ready.owner)).status,200);
      const approved=await send(certs,ready.port,'admin','/v1/operations/approve',ready.input);assert.equal(approved.status,200);
      const operationID=approved.output.operationID;
      assert.equal((await send(certs,ready.port,'qa','/v1/operations/admit',{operationID})).status,200);
      const checkpoint=once(child,'message');child.send('execute');assert.equal((await checkpoint)[0].checkpoint,point);
      const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');
      assert.equal(Object.values((await brokerStore(directory).load()).operations)[0].status,point==='before-rename'?'preflight':'effect_pending');
      await assert.rejects(application(directory,certs,{configure:f=>{f.adapter.stop=async()=>({cleaned:true});}}),/Unreconciled/);
      const app=await application(directory,certs);
      try{
        const status=await send(certs,app.port,'qa','/v1/operations/status',{operationID});assert.equal(status.output.status,'stopped');assert.equal(app.calls.length,0);
        const retry=await send(certs,app.port,'qa','/v1/operations/admit',{operationID});assert.equal(retry.output.status,'stopped');assert.equal(app.calls.length,0);
      }finally{await app.close();}
    }finally{if(!child.killed)child.kill('SIGKILL');}
  });

  for(const stage of ['approved','admitted','succeeded'])await t.test(`lost HTTP ${stage} response reconciles without duplicate effect`,async()=>{
    const entered=gate(),release=gate();let armed=false;
    const f=await setup({saveHook:async s=>{if(armed&&s.operationAudit?.at(-1)?.type===stage){armed=false;entered.resolve();await release.promise;}}});await owner(f);
    let row;if(stage!=='approved')row=await approve(f);
    if(stage==='succeeded'){
      await f.http('qa','/v1/operations/admit',{operationID:row.operationID});armed=true;
      const pending=f.runtime.operations.execute(row.operationID);await entered.promise;
      release.resolve();await pending;
      await send(certs,f.port,'qa','/v1/operations/status',{operationID:row.operationID},{dropResponse:true});
    }else{
      armed=true;const path=stage==='approved'?'/v1/operations/approve':'/v1/operations/admit',input=stage==='approved'?f.request():{operationID:row.operationID};
      const req=disconnect(certs,f.port,stage==='approved'?'admin':'qa',path,input);await entered.promise;req.destroy();release.resolve();
      const retry=await f.http(stage==='approved'?'admin':'qa',path,input);assert.equal(retry.status,200);row=retry.output;
      if(stage==='approved')assert.equal((await f.http('admin',path,{...input,operation:'edit'})).status,409);
    }
    const s=await f.store.load();assert.equal(Object.keys(s.operations).length,1);assert.equal(s.operationAudit.filter(x=>x.type==='approved').length,1);
    if(stage==='succeeded'){const status=await f.http('qa','/v1/operations/status',{operationID:row.operationID});assert.equal(status.output.status,'succeeded');assert.equal(f.calls.length,1);}
  });

  for(const stage of ['preflight','execute','verification'])await t.test(`HTTP revoke during ${stage} rejects late success`,async()=>{
    const entered=gate(),release=gate();
    const f=await setup({configure:f=>{if(stage==='verification'){const verify=f.options.operations.verifyEvidence;f.options.operations.verifyEvidence=async(...args)=>{if(args[2]==='terminal'){entered.resolve();await release.promise;}return verify(...args);};}}});await owner(f);
    if(stage!=='verification')f.adapter[stage]=async row=>{entered.resolve();await release.promise;return f.proof(row,stage==='preflight'?'preflight':'terminal');};
    const row=await approve(f);await f.http('qa','/v1/operations/admit',{operationID:row.operationID});
    const pending=f.runtime.operations.execute(row.operationID);await entered.promise;assert.equal((await f.http('owner','/revoke',f.signed('revoke'))).status,200);release.resolve();
    await assert.rejects(pending);assert.equal(Object.keys((await f.store.load()).operationReceipts??{}).length,0);
  });

  await t.test('lost external response, unknown cleanup and network restart retain uncertainty',async()=>{
    const f=await setup();await owner(f);f.adapter.execute=async()=>{f.calls.push('effect');throw Error('lost external response');};f.adapter.stop=async()=>({cleaned:true});
    const row=await approve(f);await f.http('qa','/v1/operations/admit',{operationID:row.operationID});await assert.rejects(f.runtime.operations.execute(row.operationID));
    assert.equal((await f.http('qa','/v1/operations/status',{operationID:row.operationID})).output.status,'uncertain');
    await assert.rejects(f.runtime.operations.recover(),/Unreconciled/);assert.equal(f.calls.length,1);
    f.adapter.stop=async r=>f.proof(r,'stopped');await f.runtime.operations.recover();
  });
});
