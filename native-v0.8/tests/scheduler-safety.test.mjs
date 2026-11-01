import test from 'node:test';
import assert from 'node:assert/strict';
import {TeamRoom} from '../src/room.mjs';
function fixture(){
  let state={status:'ready',members:{backend:{role:'backend',sessionID:'backend',directory:'/synthetic/shared-worktree'}},messages:[],tasks:[]};
  const rows=[],calls=[];
  const ctx={storage:{get:async()=>structuredClone(state),set:async(_,v)=>{state=structuredClone(v);}},session:{context:async()=>rows,prompt:async p=>{calls.push(p);rows.push({id:p.id,type:'user'});return {id:p.id};}}};
  return {room:new TeamRoom(ctx),ctx,rows,calls,state:()=>state};
}
const task=key=>({key,assignee:'backend',title:key,description:'Synthetic read-only task'});
test('active A retains B/control; concurrent assignments and retry after reopen do not duplicate',async()=>{
  const f=fixture(),directory='/synthetic/project';
  await f.room.assignBatch(directory,'admin',{requestID:'a',tasks:[task('a')]});
  await Promise.all(['b','c'].map(key=>f.room.assignBatch(directory,'admin',{requestID:key,tasks:[task(key)]})));
  await new TeamRoom(f.ctx).assignBatch(directory,'admin',{requestID:'b',tasks:[task('b')]});
  await f.room.send(directory,'owner','backend','stop request is only chat',{kind:'control'});
  assert.equal(f.calls.length,1);assert.equal(f.state().tasks.length,3);
  assert.equal(f.state().messages.filter(m=>m.status==='waiting').length,3);
  f.rows.push({id:'long',type:'assistant',content:[]});await f.room.sync(directory);assert.equal(f.calls.length,1);
});
test('uncertain delivery retains B; no lease means safe-terminal contract remains BLOCKED',async()=>{
  const f=fixture(),directory='/synthetic/project';
  f.ctx.session.prompt=async()=>{throw Error('unknown admission');};
  await f.room.assignBatch(directory,'admin',{requestID:'a',tasks:[task('a')]});
  await f.room.assignBatch(directory,'admin',{requestID:'b',tasks:[task('b')]});
  assert.equal(f.state().messages.find(m=>m.taskID===f.state().tasks[0].id).status,'uncertain');
  assert.equal(f.state().messages.find(m=>m.taskID===f.state().tasks[1].id).status,'waiting');
  assert.equal(f.state().sessionLease,undefined);
});
for(const outcome of ['succeeded','failed','interrupted'])test(`documents unsafe handoff gap: ${outcome} model idle releases slot despite unfinished task/background effect`,async()=>{
  const f=fixture(),directory='/synthetic/project';let backgroundRunning=true;
  await f.room.assignBatch(directory,'admin',{requestID:'a',tasks:[task('a')]});
  await f.room.assignBatch(directory,'admin',{requestID:'b',tasks:[task('b')]});
  f.rows.push({id:'idle',type:'idle',outcome});await f.room.sync(directory);
  assert.equal(f.calls.length,2);assert.equal(f.state().tasks[0].status,'todo');assert.equal(backgroundRunning,true);
  assert.equal(f.state().tasks[0].directory,f.state().tasks[1].directory);
  // This passing regression exposes missing enforcement, NOT safe handoff PASS.
  const trustedLease=null;
  assert.equal(trustedLease?'eligible':'BLOCKED','BLOCKED');
});
