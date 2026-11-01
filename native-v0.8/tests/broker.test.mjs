import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {verifyDecision,withBrokerLedger,digest} from '../src/broker.mjs';
import {createSnapshot,verifySnapshot} from '../src/build-snapshot.mjs';
import {executeFixed} from '../src/broker-executor.mjs';
import {BuildJobs} from '../src/build-jobs.mjs';
import {BUILD_IMAGE} from '../src/build.mjs';
import {inspectMavenCache} from '../src/maven-cache.mjs';
test('signed project scope survives reopen; forged/tampered/replayed/expired/revoked decisions fail',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),foreign=generateKeyPairSync('ed25519');
  const manifest=Buffer.from('exact manifest bytes'),d={operation:'approve',projectID:'projectA',scopeID:'scopeA',nonce:'nonceA',epoch:0,expiresAt:Date.now()+60000,manifestHash:digest(manifest)},bytes=Buffer.from(JSON.stringify(d));
  const signature=sign(null,bytes,privateKey);assert.deepEqual(verifyDecision(bytes,signature,publicKey,manifest),d);
  assert.throws(()=>verifyDecision(bytes,signature,foreign.publicKey,manifest),/signature/);
  assert.throws(()=>verifyDecision(bytes,signature,publicKey,Buffer.from('changed')),/binding/);
  assert.throws(()=>verifyDecision(bytes,signature,publicKey,manifest,d.expiresAt),/binding/);
  const dir=await mkdtemp('/tmp/opencode/broker-');
  await withBrokerLedger(dir,async l=>{await l.apply(bytes,signature,manifest);await assert.rejects(l.apply(bytes,signature,manifest),/replay/);assert.throws(()=>l.authorize('projectB',d.scopeID,d.manifestHash,0),/denied/);},publicKey);
  await withBrokerLedger(dir,async l=>{l.authorize(d.projectID,d.scopeID,d.manifestHash,0);const r=Buffer.from(JSON.stringify({...d,operation:'revoke',nonce:'nonceB',epoch:1}));await l.apply(r,sign(null,r,privateKey),manifest);assert.throws(()=>l.authorize(d.projectID,d.scopeID,d.manifestHash,0),/denied/);assert.equal(l.view().audit.length,2);},publicKey);
});
test('fixed executor builds and independently reruns same snapshot; denies stale QA and changed POM',async()=>{
  const root=await mkdtemp('/tmp/opencode/fixed-'),snapshot=await createSnapshot(root,[{path:'pom.xml',base64:Buffer.from('<project/>').toString('base64')},{path:'src/Main.java',base64:Buffer.from('class Main {}').toString('base64')}]);
  let state={jobs:[]};const labels=new Map();
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{create:async x=>{labels.set(x.name,x.labels);return x.name;},start:async()=>{},wait:async()=>({exitCode:0}),logs:async()=>'test output',inspect:async id=>({labels:labels.get(id),running:false}),remove:async()=>{}}});
  const manifestBytes=Buffer.from(JSON.stringify({projectID:'p',scopeID:'s',image:BUILD_IMAGE,inputs:snapshot.inventory.filter(f=>f.path==='pom.xml'),members:[{sessionID:'backend',role:'backend',goals:['test'],files:['src/Main.java']},{sessionID:'qa',role:'qa',goals:['test'],files:['src/Main.java']}]}));
  const args={ledger:{authorize:(p,s,h)=>{assert.equal(p,'p');assert.equal(s,'s');assert.equal(h,digest(manifestBytes));}},jobs,manifestBytes,projectID:'p',scopeID:'s',epoch:0,taskID:'t',goal:'test',snapshot,cache:root,uid:1000,gid:1000,runRoot:root};
  const build=await executeFixed({...args,sessionID:'backend'});assert.equal(build.state,'succeeded');
  const qa=await executeFixed({...args,sessionID:'qa',buildID:build.id});assert.equal(qa.snapshotHash,build.snapshotHash);assert.notEqual(qa.id,build.id);assert.equal(qa.output,'test output');
  await assert.rejects(executeFixed({...args,sessionID:'backend',buildID:build.id}),/requires QA/);
  await assert.rejects(executeFixed({...args,sessionID:'qa',buildID:'missing'}),/mismatch/);
  const changed=await createSnapshot(root,[{path:'pom.xml',base64:Buffer.from('changed').toString('base64')}]);
  await assert.rejects(executeFixed({...args,snapshot:changed,sessionID:'backend'}),/inputs/);
});
test('snapshot rejects traversal and duplicate paths; copied bytes independent of worker envelope',async()=>{
  const parent=await mkdtemp('/tmp/opencode/snapshot-'),files=[{path:'src/Main.java',base64:Buffer.from('original').toString('base64')}];
  await assert.rejects(createSnapshot(parent,[{...files[0],path:'../escape'}]),/path/);
  await assert.rejects(createSnapshot(parent,[...files,...files]),/path/);
  const s=await createSnapshot(parent,files);files[0].base64=Buffer.from('changed').toString('base64');await verifySnapshot(s);
  await assert.rejects(createSnapshot(parent,[{path:'a',base64:'!'}]),/content/);
});
test('cache preflight never labels inventory as offline dependency sufficiency',async()=>{
  const dir=await mkdtemp('/tmp/opencode/cache-');assert.equal((await inspectMavenCache(dir)).status,'empty');
  await writeFile(dir+'/artifact.lastUpdated','failed');const result=await inspectMavenCache(dir);
  assert.equal(result.status,'unverified');assert.equal(result.offlineSufficiency,'requires-approved-maven-probe');assert.deepEqual(result.failedTransfers,['artifact.lastUpdated']);
});
