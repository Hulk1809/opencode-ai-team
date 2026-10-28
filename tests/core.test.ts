import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../apps/server/src/store.ts';
import { Team } from '../apps/server/src/team.ts';
import { modelRef } from '../apps/server/src/opencode.ts';

test('SQLite persists; dedupe, loop guard, dependency, QA approval and recovery hold',()=>{
  const dir=mkdtempSync('/tmp/opencode/team-test-');const path=join(dir,'test.sqlite');
  const store=new Store(path);const team=new Team(store,dir,4310);
  const p=store.add('projects',{name:'test',path:dir,paused:true});
  const msg={projectID:p.id,receiver:'admin',body:'Inspect source',idempotencyKey:'1'};
  const first=team.send(msg);assert.equal(team.send(msg).id,first.id);
  assert.throws(()=>team.send({...msg,body:'different'}),/conflict/);
  assert.throws(()=>team.send({...msg,idempotencyKey:'2'},'backend',{...first,hops:6}),/limit/);
  const a=team.task({projectID:p.id,title:'contract',assignee:'backend',criteria:'tests pass'});
  const b=team.task({projectID:p.id,title:'UI',assignee:'frontend',criteria:'uses contract',dependencies:[a.id]});
  assert.throws(()=>team.updateTask(b.id,{status:'In Progress'},'frontend'),/Dependency/);
  assert.throws(()=>team.updateTask(a.id,{status:'Done',evidence:'trust me'},'backend'),/QA/);
  assert.throws(()=>team.updateTask(a.id,{status:'Done',evidence:''},'qa'),/QA/);
  team.updateTask(a.id,{status:'Done',evidence:'node --test: 1 passed'},'qa');
  assert.equal(team.updateTask(b.id,{status:'In Progress'},'frontend').status,'In Progress');
  store.patch('messages',first.id,{status:'processing'});store.db.close();
  const restored=new Store(path);new Team(restored,dir,4310);
  assert.equal(restored.get('messages',first.id).status,'uncertain');
  assert.equal(restored.all('tasks').length,2);assert.equal(restored.all('projects').length,1);
  restored.db.close();
});
test('model refs keep slash inside model ID',()=>{
  assert.deepEqual(modelRef('taile/cx/model'),{providerID:'taile',id:'cx/model'});
  assert.throws(()=>modelRef('invalid'));assert.throws(()=>modelRef('p/'));
});
