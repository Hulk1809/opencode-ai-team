import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {peerPlan,teamView,PEER_GENERATION} from '../src/peer-team.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {DEFAULT_MODELS} from '../src/model-routing.mjs';

test('peer plans validate membership, version and non-mutating legacy projection',()=>{
  assert.equal(peerPlan().members.length,4);
  assert.equal(peerPlan({members:[{id:'peer-custom',label:'Custom'}]}).members.length,1);
  for(const value of [null,[],{generation:'stale'},{extra:true},{members:[]},{members:[{id:'admin',label:'Admin'}]},{members:[{id:'peer-a',label:'A'},{id:'peer-a',label:'B'}]}])assert.throws(()=>peerPlan(value));
  assert.equal(peerPlan({generation:PEER_GENERATION}).generation,PEER_GENERATION);
  const old={members:[{role:'admin',sessionID:'ses_old'}],messages:[{from:'worker-1'}]};
  const bytes=JSON.stringify(old),view=teamView(old);
  assert.equal(view.schemaVersion,1);assert.equal(view.mode,'legacy');assert.equal(JSON.stringify(old),bytes);
});

test('non-Git concurrent provisioning, peer claims/review and reload preserve native bindings',async()=>{
  const root=mkdtempSync('/tmp/opencode/peer-test-'),sessions=new Map();
  const ctx={location:{directory:root,project:{canonical:root,id:'project'}},options:{pilotStore:join(root,'store')},
    model:{list:async()=>[{...DEFAULT_MODELS.worker,enabled:true,status:'active',variants:[{id:'medium'}]}]},
    worktree:{create:async()=>{throw Error('NON_GIT_WORKTREE_FORBIDDEN');}},
    session:{create:async input=>{const s={...input,id:`ses_${sessions.size}`,projectID:'project',agent:'build'};sessions.set(s.id,s);return s;},get:async({sessionID})=>sessions.get(sessionID)}};
  try{
    const c=new OfficialCoordinator(ctx),other=new OfficialCoordinator(ctx);
    await Promise.all([c.bootstrap(),other.bootstrap()]);
    assert.equal(sessions.size,4);assert.equal(c.read().status,'ready');assert.equal(existsSync(join(root,'.git')),false);
    for(const s of sessions.values())assert.deepEqual(s.permissions.map(p=>[p.action,p.effect]),[['edit','deny'],['shell','deny'],['subagent','deny']]);
    const a={sessionID:c.read().members[0].sessionID,agent:'build'},b={sessionID:c.read().members[1].sessionID,agent:'build'};
    const task=await c.execute('assign',{recipient:'team',text:'Task'},a);
    await c.execute('claim',{taskID:task.taskID},b);
    await assert.rejects(c.execute('claim',{taskID:task.taskID},a),/PEER_TASK_ALREADY_CLAIMED/);
    const before=readFileSync(c.file,'utf8');
    await assert.rejects(c.execute('review',{taskID:task.taskID,recipient:'team',text:'Self'},b),/PEER_INDEPENDENT_REVIEW_REQUIRED/);
    await assert.rejects(c.execute('unknown',{recipient:'owner',text:'No'},a),/PILOT_ACTION_INVALID/);
    assert.equal(readFileSync(c.file,'utf8'),before);
    await c.execute('review',{taskID:task.taskID,recipient:'team',text:'Independent'},a);
    assert.equal(c.read().tasks[0].reviews[0].memberID,'peer-1');
    await assert.rejects(c.wake(task),/PEER_NATIVE_DISPATCH_DISABLED/);
    assert.deepEqual(new OfficialCoordinator(ctx).read(),c.read());
    await other.bootstrap();assert.equal(sessions.size,4);
  }finally{rmSync(root,{recursive:true,force:true});}
});
