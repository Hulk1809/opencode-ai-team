import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {approveWorktree,assertScopedPath} from '../src/permissions.mjs';

test('coding approval rejects missing approval, glob paths, secrets and arbitrary commands before session changes',async()=>{
  for(const p of [
    {role:'frontend',approved:false,files:['Hello.java'],commands:[]},
    {role:'backend',approved:true,files:['../Hello.java'],commands:[]},
    {role:'qa',approved:true,files:['*.java'],commands:[]},
    {role:'devops',approved:true,files:['.env'],commands:[]},
    {role:'backend',approved:true,files:['Hello.java'],commands:['mvn test; rm -rf /']},
  ])await assert.rejects(approveWorktree({}, {}, '/project',p));
});
test('scoped paths reject sibling traversal and symlink escape, including new files',async()=>{
  const root=await mkdtemp('/tmp/opencode/scope-'),tree=join(root,'tree'),outside=join(root,'outside');
  await mkdir(tree);await mkdir(outside);await symlink(outside,join(tree,'link'));
  assert.equal(await assertScopedPath(tree,'Hello.java'),join(tree,'Hello.java'));
  for(const path of ['../outside/x','link/New.java','.env','src/key.pem','.git/config'])await assert.rejects(assertScopedPath(tree,path));
});
