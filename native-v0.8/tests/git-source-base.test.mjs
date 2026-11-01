import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {gitSourceBase} from '../src/git-source-base.mjs';
import {digest} from '../src/broker.mjs';
const exec=promisify(execFile);
test('trusted Git fixture resolves raw complete tree, ignores filters/hooks and detects ref/base drift',async t=>{
  const root=await mkdtemp('/tmp/opencode/git-base-');t.after(()=>rm(root,{recursive:true,force:true}));
  const git=async args=>(await exec('/usr/bin/git',['-C',root,...args],{env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout.trim();
  await git(['init','-b','fixture']);await mkdir(root+'/src');await writeFile(root+'/src/main.txt','base bytes');
  await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
  const commit=await git(['rev-parse','HEAD']),tree=await git(['rev-parse','HEAD^{tree}']);
  await git(['config','filter.evil.smudge','false']);await writeFile(root+'/.git/hooks/post-checkout','exit 99');
  const resolve=gitSourceBase({gitDirectory:root+'/.git',ref:'refs/heads/fixture',commit,tree});
  assert.deepEqual(await resolve({baseCommit:commit}),[{path:'src/main.txt',mode:'100644',sha256:digest('base bytes'),size:10}]);
  await assert.rejects(resolve({baseCommit:'a'.repeat(40)}),/drift/);
  await writeFile(root+'/src/main.txt','changed');await git(['add','.']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','next']);
  await assert.rejects(resolve({baseCommit:commit}),/drift/);
  // Raw tree modes reject executables, symlinks and submodule entries, without checkout.
  const blob=await git(['rev-parse',commit+':src/main.txt']);
  for(const [mode,type,oid] of [['100755','blob',blob],['120000','blob',blob],['160000','commit',commit]]){
    // mktree input supplied with a bounded pipe, not a shell.
    const {spawn}=await import('node:child_process');
    const raw=await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/git',['-C',root,'mktree'],{env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});let out='';child.stdout.on('data',c=>out+=c);child.on('error',reject);child.on('close',code=>code?reject(Error('mktree failed')):resolve(out.trim()));child.stdin.end(`${mode} ${type} ${oid}\tunsafe\n`);});
    const p=await exec('/usr/bin/git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit-tree',raw,'-m','unsafe']);
    const badCommit=p.stdout.trim();await git(['update-ref','refs/heads/unsafe',badCommit]);
    await assert.rejects(gitSourceBase({gitDirectory:root+'/.git',ref:'refs/heads/unsafe',commit:badCommit,tree:raw})({baseCommit:badCommit}),/mode\/submodule/);
  }
});
