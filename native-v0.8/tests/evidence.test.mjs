import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {sourceRevision,currentEvidence} from '../src/evidence.mjs';

test('revision evidence detects untracked source changes and stale test results',async()=>{
  const directory=await mkdtemp('/tmp/opencode/revision-');
  const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8'});
  git('init','--quiet');
  // No commit needed: empty tree is a fixture-only Git base.
  const tree=git('hash-object','-t','tree','--stdin').trim();
  const sha=execFileSync('git',['-C',directory,'commit-tree',tree,'-m','fixture base'],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
  git('update-ref','HEAD',sha);
  await writeFile(`${directory}/Example.java`,'class Example {}\n');
  const first=await sourceRevision(directory);
  assert.equal(first.baseSHA,sha);assert.equal(first.sources[0].path,'Example.java');
  const evidence={revision:first.revision,beforeRevision:first.revision,exitCode:0};
  assert.equal(currentEvidence(evidence,first.revision),true);
  await writeFile(`${directory}/Example.java`,'class Example { int value = 1; }\n');
  const next=await sourceRevision(directory);
  assert.equal(currentEvidence(evidence,next.revision),false);
  assert.equal(currentEvidence({...evidence,beforeRevision:'changed during tests'},first.revision),false);
  assert.equal(currentEvidence({...evidence,exitCode:1},first.revision),false);
});
