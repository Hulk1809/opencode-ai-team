import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fixture,h} from './fixtures/operation-fixture.mjs';

async function setup(t){const dir=await mkdtemp('/tmp/opencode/operations-');t.after(()=>rm(dir,{recursive:true,force:true}));const f=await fixture(dir);await f.approveOwner();return f;}
async function approve(f,request=f.request()){return f.control.handlers.operationApprove(f.peer('admin'),request);}
async function run(f,row){await f.control.handlers.operationAdmit(f.peer(row.workerSessionID),{operationID:row.operationID});return f.control.operations.execute(row.operationID);}
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:x=>resolve(x)};};

for(const when of ['before','after'])for(const point of ['approve','approved','admitted','preflight','effect-intent','succeeded'])test(`SIGKILL ${when} durable ${point}; restart reconciles without replay`,{timeout:10000},async t=>{
  const directory=await mkdtemp('/tmp/opencode/operations-crash-');t.after(()=>rm(directory,{recursive:true,force:true}));
  const child=fork(new URL('./fixtures/operation-crash-child.mjs',import.meta.url),[directory,point,when],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
  const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error(`Child exited before checkpoint: ${code}`);})]);
  assert.equal(message.point,point);const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');
  const f=await fixture(directory),s=await f.store.load(),row=Object.values(s.operations??{})[0];
  if(row){assert.equal(row.status,when==='after'&&point==='approved'||when==='before'&&point==='admitted'?'approved':point==='succeeded'&&when==='after'?'succeeded':'stopped');}
  assert.equal(f.calls.length,0);
  assert.equal(Object.keys(s.operationReceipts??{}).length,point==='succeeded'&&when==='after'?1:0);
});

test('integrated signed Owner -> Admin -> independent QA -> push receipt; lost responses deduplicate',async t=>{
  const f=await setup(t);
  // The original signed decision, not a newly signed expiry, is the retry identity.
  const directory=await mkdtemp('/tmp/opencode/operations-owner-');t.after(()=>rm(directory,{recursive:true,force:true}));
  const g=await fixture(directory);
  const owner=g.signed('approve');await g.approveOwner(owner);await g.approveOwner(owner);
  const row=await approve(f);assert.deepEqual(await approve(f),row);
  const input={operationID:row.operationID},worker=f.peer('qa');
  const admitted=await f.control.handlers.operationAdmit(worker,input);
  assert.deepEqual(await f.control.handlers.operationAdmit(worker,input),admitted);
  const qa=await f.control.operations.execute(row.operationID);
  const push=await approve(f,{...f.request('push','push','devops'),qaReceiptID:qa.receiptID});
  const result=await run(f,push);assert.equal(result.status,'succeeded');
  const s=await f.store.load();assert.equal(s.operationReceipts[qa.receiptID].kind,'qa');assert.equal(Object.keys(s.operations).length,2);assert.equal(f.calls.length,2);
  assert.equal(s.operationAudit.filter(x=>x.type==='approved').length,2);
  await assert.rejects(approve(f,{...f.request(),operation:'edit'}),/payload mismatch/);
  await assert.rejects(f.control.operations.execute(row.operationID),/not executable/);
  await assert.rejects(f.control.handlers.operationStatus({...worker,role:'devops'},input),/not visible/);
});

test('fake QA, worker PASS, wrong identity and stale revision denied; edit advances revision',async t=>{
  const f=await setup(t);
  await assert.rejects(approve(f,{...f.request('push','push','devops'),qaReceiptID:'fake'}),/QA receipt/);
  await assert.rejects(f.control.handlers.operationApprove(f.peer('backend'),f.request()),/Admin/);
  const qa=await run(f,await approve(f));
  const edit=await approve(f,f.request('edit','edit','backend'));
  f.adapter.execute=async row=>{Object.assign(f.snapshot,{snapshotHash:'d'.repeat(64),revision:'r2'});return f.proof(row,'terminal',{resultSnapshotHash:'d'.repeat(64),resultRevision:'r2'});};
  await run(f,edit);
  assert.equal((await f.store.load()).tasks['["synthetic","task"]'].acceptanceEpoch,1);
  await assert.rejects(approve(f,{...f.request('stale','push','devops'),qaReceiptID:qa.receiptID}),/superseded/);
  assert.equal((await f.control.handlers.taskPolicy(f.peer('admin'),{taskID:'task'})).revision,'r2');
  const g=await setup(t);g.adapter.execute=async()=>({cleaned:true,outputHash:h,success:true});
  await assert.rejects(run(g,await approve(g)),/unverified/);
  assert.equal(Object.keys((await g.store.load()).operationReceipts??{}).length,0);
});

for(const stage of ['preflight','execution'])test(`revoke during ${stage} suppresses late receipt`,async t=>{
  const f=await setup(t),started=gate(),finish=gate(),row=await approve(f);
  f.adapter[stage==='preflight'?'preflight':'execute']=async r=>{started.resolve();await finish.promise;return f.proof(r,stage==='preflight'?'preflight':'terminal');};
  const pending=run(f,row);await started.promise;
  await f.control.handlers.revoke({kind:'owner'},f.signed('revoke'));finish.resolve();
  await assert.rejects(pending,/scope denied|cancelled/i);
  assert.equal(Object.keys((await f.store.load()).operationReceipts??{}).length,0);
  await assert.rejects(approve(f,f.request('after')),/scope denied/i);
});

test('lost effect response and failed cleanup stay uncertain; recovery never replays',async t=>{
  const f=await setup(t),row=await approve(f);
  f.adapter.execute=async()=>{f.calls.push('effect completed');throw Error('response lost');};
  f.adapter.stop=async()=>({cleaned:true});
  await assert.rejects(run(f,row),/response lost/);
  assert.equal((await f.store.load()).operations[row.operationID].status,'uncertain');
  const other=await approve(f,f.request('other'));
  await assert.rejects(f.control.handlers.operationAdmit(f.peer('qa'),{operationID:other.operationID}),/Unreconciled/);
  await assert.rejects(f.control.recover(),/Unreconciled/);
  await assert.rejects(approve(f,f.request('closed')),/closed/);
  f.adapter.stop=async r=>f.proof(r,'stopped');await f.control.recover();
  assert.equal((await f.store.load()).operations[row.operationID].status,'stopped');assert.equal(f.calls.length,1);
});

for(const key of ['revision','authorizationEpoch'])test(`${key} changed before finalization rejects receipt`,async t=>{
  const f=await setup(t),started=gate(),finish=gate();
  f.adapter.execute=async r=>{started.resolve();await finish.promise;return f.proof(r,'terminal');};
  const pending=run(f,await approve(f));await started.promise;
  const s=await f.store.load();s.tasks['["synthetic","task"]'][key]=key==='revision'?'r2':1;await f.store.save(s);finish.resolve();
  await assert.rejects(pending,/superseded/);assert.equal(Object.keys((await f.store.load()).operationReceipts??{}).length,0);
});

test('expiry blocks admission and late completion; store failure closes operation admission',async t=>{
  const f=await setup(t),row=await approve(f),started=gate(),finish=gate();
  f.adapter.execute=async r=>{started.resolve();await finish.promise;return f.proof(r,'terminal');};
  const pending=run(f,row);await started.promise;f.time(Date.now()+120000);await f.control.expire();finish.resolve();
  await assert.rejects(pending,/scope denied/i);
  await assert.rejects(approve(f,f.request('expired')),/scope denied/i);
  const directory=await mkdtemp('/tmp/opencode/operations-failure-');t.after(()=>rm(directory,{recursive:true,force:true}));
  let fail=false;
  const g=await fixture(directory,{saveHook:async()=>{if(fail)throw Error('lost save response');}});await g.approveOwner();
  fail=true;await assert.rejects(approve(g),/lost save response/);fail=false;
  await assert.rejects(approve(g),/closed/);await g.control.recover();
  assert.equal((await approve(g)).status,'approved');
});
