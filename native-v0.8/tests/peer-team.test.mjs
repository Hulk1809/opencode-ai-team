import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {peerPlan,teamView,PEER_GENERATION} from '../src/peer-team.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {DEFAULT_MODELS} from '../src/model-routing.mjs';
import {execFileSync} from 'node:child_process';

test('peer plans validate membership, version and non-mutating legacy projection',()=>{
  assert.equal(peerPlan().members.length,4);
  assert.equal(peerPlan({members:[{id:'peer-custom',label:'Custom'}]}).members.length,1);
  for(const value of [null,[],{generation:'stale'},{extra:true},{members:[]},{members:[{id:'admin',label:'Admin'}]},{members:[{id:'peer-a',label:'A'},{id:'peer-a',label:'B'}]}])assert.throws(()=>peerPlan(value));
  assert.equal(peerPlan({generation:PEER_GENERATION}).generation,PEER_GENERATION);
  const old={members:[{role:'admin',sessionID:'ses_old'}],messages:[{from:'worker-1'}]};
  const bytes=JSON.stringify(old),view=teamView(old);
  assert.equal(view.schemaVersion,1);assert.equal(view.mode,'legacy');assert.equal(JSON.stringify(old),bytes);
});

test('read-only migration preserves data/models, isolates four peers and blocks unsafe retries',async()=>{
  const root=mkdtempSync('/tmp/opencode/peer-upgrade-'),sessions=new Map();
  let active={},created=0,fail=false;
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  const ctx={location:{directory:root,project:{canonical:root,id:'project'}},options:{pilotStore:join(root,'store')},
    model:{list:async()=>[{...DEFAULT_MODELS.worker,enabled:true,status:'active',variants:[{id:'medium'}]}]},
    worktree:{create:async()=>{created++;if(fail)throw Error('NATIVE_FAILURE');const directory=join(root,`wt-${created}`);git('worktree','add','--detach',directory);return {directory};}},
    session:{active:async()=>active,create:async input=>{const s={...input,id:`ses_${sessions.size}`,projectID:ctx.location.project.id};sessions.set(s.id,s);return s;},get:async({sessionID})=>sessions.get(sessionID)}};
  try{
    const c=new OfficialCoordinator(ctx);await c.bootstrap();
    const first=c.read().members[0];sessions.get(first.sessionID).model={providerID:'taile',id:'ag/claude-sonnet-5-5-medium',variant:'medium'};
    c.mutate(state=>{state.messages=[{text:'keep chat'}];state.plans=[{text:'keep plan'}];return {};});
    await assert.rejects(c.upgradeWorktrees(),/PILOT_GIT_PROJECT_REQUIRED/);
    git('init');git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','initial');
    active={[first.sessionID]:{}};await assert.rejects(c.upgradeWorktrees(),/PILOT_UPGRADE_SESSION_ACTIVE/);assert.equal(created,0);active={};
    const before=c.read();
    ctx.location.project.id='git-project';
    delete ctx.session.active;let waited=0;ctx.session.wait=async()=>{waited++;};
    for(const s of sessions.values())s.projectID='git-project';
    const [a,b]=await Promise.allSettled([c.upgradeWorktrees(),c.upgradeWorktrees()]);
    assert.equal([a,b].filter(r=>r.status==='fulfilled').length,1);
    const after=c.read();assert.equal(after.status,'ready');assert.equal(after.isolation,'git-worktree');assert.equal(created,4);
    assert.equal(after.projectID,'git-project');assert.equal(after.previousProjectID,'project');
    assert.ok(waited>=4);
    assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.previousMembers,before.members);
    assert.equal(new Set(after.members.map(m=>m.directory)).size,4);assert.equal(new Set(after.members.map(m=>m.branch)).size,4);
    assert.deepEqual(after.members[0].modelDefault,sessions.get(first.sessionID).model);
    assert.equal(sessions.size,8);await assert.rejects(c.upgradeWorktrees(),/PILOT_UPGRADE_STATE_INVALID/);
    // Separate team fixture exercises uncertain native effects without altering successful migration.
    ctx.options.pilotStore=join(root,'failed-store');const broken=new OfficialCoordinator(ctx);
    broken.mutate(()=>({state:{...before,status:'ready'},value:true}));fail=true;
    await assert.rejects(broken.upgradeWorktrees(),/NATIVE_FAILURE/);assert.equal(broken.read().status,'upgrading');
    await assert.rejects(broken.upgradeWorktrees(),/PILOT_UPGRADE_STATE_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
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
