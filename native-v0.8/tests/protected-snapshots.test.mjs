import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,link,unlink,rm,rename} from 'node:fs/promises';
import {brokerArtifacts} from '../src/broker-artifacts.mjs';
import {protectedSnapshots,sourcePath} from '../src/protected-snapshots.mjs';
import {verifySourceEvidence} from '../src/qa-evidence.mjs';
import {digest} from '../src/broker.mjs';
import {gitSourceBase} from '../src/git-source-base.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {application,certificates,loadCertificates,send} from './fixtures/operation-http-harness.mjs';

async function fixture(t){
  const root=await mkdtemp('/tmp/opencode/source-proof-');t.after(()=>rm(root,{recursive:true,force:true}));
  const proposal=root+'/proposal';await mkdir(proposal+'/src',{recursive:true});await writeFile(proposal+'/src/main.js','exact bytes\n',{mode:0o600});
  const artifacts=brokerArtifacts(root+'/artifacts'),base=[];
  const writer={resolveBase:async()=>base,withSource:async(_,fn)=>fn(proposal)};
  const snapshots=protectedSnapshots({artifacts,...writer});
  const binding={projectID:'synthetic',taskID:'task',revision:'r1',acceptanceEpoch:0,baseCommit:'c'.repeat(40),repository:'example/synthetic',repositoryID:'123',branch:'ai-team/task',authorSessionID:'backend',authorPrincipalID:'principal_backend',allowPaths:['src']};
  return {root,proposal,artifacts,base,writer,snapshots,binding};
}

test('protected manifest binds exact bytes and complete diff; add/delete/rename outside policy denied',async t=>{
  const f=await fixture(t),a=await f.snapshots.capture(f.binding);
  assert.equal(a.files[0].sha256,digest('exact bytes\n'));assert.equal((await f.artifacts.read(a.files[0].sha256)).toString(),'exact bytes\n');
  assert.equal((await f.snapshots.capture(f.binding)).snapshotHash,a.snapshotHash);
  f.base.push({path:'outside.txt',mode:'100644',sha256:digest('old'),size:3});
  await assert.rejects(f.snapshots.capture(f.binding),/outside scope/);
  f.base.length=0;await writeFile(f.proposal+'/outside.txt','new',{mode:0o600});await assert.rejects(f.snapshots.capture(f.binding),/outside scope/);
  await unlink(f.proposal+'/outside.txt');f.base.push(...a.files);await rename(f.proposal+'/src/main.js',f.proposal+'/renamed.js');await assert.rejects(f.snapshots.capture(f.binding),/outside scope/);
  for(const p of ['../escape','/absolute','src/../escape','src\\escape','.git/config'])assert.throws(()=>sourcePath(p),/Unsafe/);
});

test('source symlinks, parent symlinks, hardlinks and unsafe/executable modes denied',async t=>{
  const f=await fixture(t),path=f.proposal+'/src/main.js',extra=f.proposal+'/src/link';
  await symlink(path,extra);await assert.rejects(f.snapshots.capture(f.binding),/symlink/);await unlink(extra);
  await link(path,extra);await assert.rejects(f.snapshots.capture(f.binding),/hardlink/);await unlink(extra);
  for(const mode of [0o666,0o755,0o2644]){await chmod(path,mode);await assert.rejects(f.snapshots.capture(f.binding),/mode/);}
  await chmod(path,0o644);await symlink(f.proposal,f.root+'/alias');
  const bad=protectedSnapshots({artifacts:f.artifacts,resolveBase:async()=>[],withSource:async(_,fn)=>fn(f.root+'/alias')});await assert.rejects(bad.capture(f.binding),/parent/);
});

test('blob/manifest tamper and artifact hardlinks detected',async t=>{
  const f=await fixture(t),a=await f.snapshots.capture(f.binding),path=f.root+'/artifacts/'+a.files[0].sha256;
  await link(path,f.root+'/extra');await assert.rejects(f.snapshots.describeSnapshot(a.snapshotHash),/tampered/);await unlink(f.root+'/extra');
  await chmod(path,0o600);await writeFile(path,'tampered');await assert.rejects(f.snapshots.describeSnapshot(a.snapshotHash),/tampered/);
  const manifest=f.root+'/artifacts/'+a.snapshotHash;await chmod(manifest,0o600);await writeFile(manifest,'{}');await assert.rejects(f.snapshots.describeSnapshot(a.snapshotHash),/tampered/);
});

test('source QA requires adapter authentication, independent principal and exact epoch/source',async t=>{
  const f=await fixture(t),s=await f.snapshots.capture(f.binding),row={...s,workerSessionID:'qa',workerPrincipalID:'principal_qa',operationID:'op',attemptID:'attempt'};
  const evidence={snapshotHash:s.snapshotHash,sourceHash:s.sourceHash,revision:s.revision,acceptanceEpoch:0,baseCommit:s.baseCommit,operationID:'op',attemptID:'attempt',qaPrincipalID:'principal_qa',checks:[{id:'synthetic',status:'pass',outputHash:digest('synthetic output')}]};
  assert.equal(await verifySourceEvidence({row,evidence,snapshot:s,verifyAdapter:async()=>true}),true);
  await assert.rejects(verifySourceEvidence({row,evidence,snapshot:s,verifyAdapter:async()=>false}),/unverified/);
  for(const change of [{revision:'r2'},{acceptanceEpoch:1},{sourceHash:digest('foreign')},{qaPrincipalID:'principal_backend'}])await assert.rejects(verifySourceEvidence({row,evidence:{...evidence,...change},snapshot:s,verifyAdapter:async()=>true}));
});

test('protected source bytes integrated through real HTTP/runtime QA/push, edit invalidates old evidence',async t=>{
  const f=await fixture(t);await certificates(f.root);const certs=await loadCertificates(f.root);
  const repo=f.root+'/trusted-git';await mkdir(repo);
  const git=async args=>(await promisify(execFile)('/usr/bin/git',['-C',repo,...args],{env:{PATH:'/usr/bin:/bin',HOME:repo,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout.trim();
  await git(['init','-b','fixture']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','base']);
  f.binding.baseCommit=await git(['rev-parse','HEAD']);
  f.writer.resolveBase=gitSourceBase({gitDirectory:repo+'/.git',ref:'refs/heads/fixture',commit:f.binding.baseCommit,tree:await git(['rev-parse','HEAD^{tree}'])});
  f.snapshots=protectedSnapshots({artifacts:f.artifacts,...f.writer});
  // Same protected artifact directory used by runtime; no independent policy store.
  const app=await application(f.root,certs,{configure:async h=>{
    h.snapshot.baseCommit=f.binding.baseCommit;
    const first=await f.snapshots.capture(f.binding);h.manifest.tasks[0].snapshotHash=first.snapshotHash;
    h.options.operations.sourceWriter=f.writer;
    const verify=h.options.operations.verifyEvidence;
    h.options.operations.verifyEvidence=(row,value,stage)=>verify(row,value,stage==='source-qa'?'terminal':stage);
    h.adapter.execute=async row=>{
      h.calls.push(row.operationID);
      if(row.operation==='edit'){
        return h.proof(row,'terminal',row.writerResult);
      }
      const snap=await f.snapshots.describeSnapshot(row.snapshotHash);
      return h.proof(row,'terminal',{snapshotHash:row.snapshotHash,sourceHash:snap.sourceHash,revision:row.revision,acceptanceEpoch:row.acceptanceEpoch,baseCommit:row.baseCommit,qaPrincipalID:row.workerPrincipalID,checks:[{id:'synthetic-only',status:'pass',outputHash:digest('not a compiler run')}]});
    };
  }});
  try{
    const http=(name,path,input)=>send(certs,app.port,name,path,input),first=app.manifest.tasks[0].snapshotHash;
    assert.equal((await http('owner','/approve',app.signed('approve'))).status,200);
    async function approve(input){const r=await http('admin','/v1/operations/approve',input);assert.equal(r.status,200);return r.output;}
    async function run(row){const admitted=await http(row.workerSessionID,'/v1/operations/admit',{operationID:row.operationID});assert.equal(admitted.status,200);if(row.operation==='edit'){
      const proposal={operationID:row.operationID,generation:admitted.output.writerGeneration,files:[{path:'src/main.js',mode:'100644',base64:Buffer.from('new candidate\n').toString('base64')}]};
      assert.equal((await http('backend','/v1/operations/proposal',{...proposal,generation:0})).status,409);
      assert.equal((await http('backend','/v1/operations/proposal',proposal)).status,200);
      assert.equal((await http('backend','/v1/operations/proposal',proposal)).status,200);
      assert.equal((await http('backend','/v1/operations/proposal',{...proposal,files:[]})).status,409);
    }return app.runtime.operations.execute(row.operationID);}
    const request=(id,operation='test',worker='qa')=>({...app.request(id,operation,worker),snapshotHash:first});
    await run(await approve(request('build','test','backend')));
    const qa=await run(await approve(request('qa')));
    const pushRequest={...request('push','push','devops'),qaReceiptID:qa.receiptID};
    const push=await approve(pushRequest);assert.equal((await approve(pushRequest)).operationID,push.operationID);
    const pushed=await run(push);assert.equal(pushed.status,'succeeded');
    assert.equal((await app.store.load()).operationReceipts[qa.receiptID].sourceHash,(await f.snapshots.describeSnapshot(first)).sourceHash);
    await run(await approve(request('edit','edit','backend')));
    assert.equal((await app.store.load()).tasks['["synthetic","task"]'].acceptanceEpoch,1);
    assert.equal((await http('admin','/v1/operations/approve',{...request('stale','push','devops'),qaReceiptID:qa.receiptID})).status,409);
    const state=await app.store.load(),task=state.tasks['["synthetic","task"]'];
    const next={...request('next'),revision:task.revision,acceptanceEpoch:task.acceptanceEpoch,snapshotHash:task.snapshotHash};
    const row=await approve(next),snap=await f.snapshots.describeSnapshot(task.snapshotHash),blob=f.root+'/artifacts/'+snap.files[0].sha256;
    const original=await f.artifacts.read(snap.files[0].sha256);
    await chmod(blob,0o600);await writeFile(blob,'tamper');
    assert.equal((await http('qa','/v1/operations/admit',{operationID:row.operationID})).status,409);
    assert.equal((await http('qa','/v1/operations/status',{operationID:row.operationID})).output.status,'approved');
    await writeFile(blob,original);
    assert.equal((await http('qa','/v1/operations/admit',{operationID:row.operationID})).status,200);
    // Trusted verifier waits while current task revision is superseded.
    const execute=app.adapter.execute;
    app.adapter.execute=async r=>{const value=await execute(r),s=await app.store.load();s.tasks['["synthetic","task"]'].revision='r3';await app.store.save(s);return value;};
    await assert.rejects(app.runtime.operations.execute(row.operationID),/superseded/);
    assert.equal((await app.store.load()).operations[row.operationID].receiptID,undefined);
    await assert.rejects(app.runtime.operations.recover(),/Recovered source binding/);
    const repaired=await app.store.load();repaired.tasks['["synthetic","task"]'].revision=task.revision;await app.store.save(repaired);await app.runtime.operations.recover();
  }finally{await app.close();}
});
