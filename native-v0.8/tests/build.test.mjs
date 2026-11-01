import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,mkdir} from 'node:fs/promises';
import {BUILD_IMAGE,buildArgs,assertBuildMount,approveBuild,executeBuild} from '../src/build.mjs';
const scope={image:BUILD_IMAGE,directory:'/fixture/worktree',cache:'/fixture/cache',goals:['test','verify'],uid:1000,gid:1000};
test('container launcher fixes image, offline goals and isolation; rejects arbitrary commands/mount syntax',()=>{
  const args=buildArgs(scope,'verify');
  for(const flag of ['--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pull=never','-o'])assert.ok(args.includes(flag));
  assert.ok(!args.some(a=>a.includes('docker.sock')||a==='--privileged'));
  assert.deepEqual(args.slice(-5),[BUILD_IMAGE,'-B','-o','-Dmaven.repo.local=/maven-cache','verify']);
  for(const goal of ['verify; id','package','--help'])assert.throws(()=>buildArgs(scope,goal));
  for(const bad of [{image:'maven:latest'},{uid:0},{directory:'/work,src=/etc'}])assert.throws(()=>buildArgs({...scope,...bad},'test'));
});
test('build mounts reject symlinks, credential names and settings.xml',async()=>{
  const root=await mkdtemp('/tmp/opencode/build-mount-');
  await writeFile(`${root}/Example.java`,'class Example {}');await assertBuildMount(root);
  await mkdir(`${root}/nested`);await symlink('/etc',`${root}/nested/escape`);
  await assert.rejects(assertBuildMount(root),/credentials/);
  const cache=await mkdtemp('/tmp/opencode/build-cache-');await writeFile(`${cache}/settings.xml`,'secret');
  await assert.rejects(assertBuildMount(cache),/credentials/);
});
test('build activation requires explicit Owner-approved pinned image before side effects',async()=>{
  for(const p of [{},{approved:true,role:'qa',image:'maven:latest'},{approved:false,role:'qa',image:BUILD_IMAGE}])await assert.rejects(approveBuild({}, {}, '/fixture',p),/Owner/);
});
test('activation and default executor remain fail closed even with plausible approval payload',async()=>{
  await assert.rejects(approveBuild({}, {}, '/fixture',{approved:true,role:'qa',image:BUILD_IMAGE}),/activation chưa mở/);
  await assert.rejects(executeBuild(scope,'verify'),/execution disabled/);
});
