import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';

test('coordinator submissions overlap across three sessions; duplicate, failure and cancellation isolated',async()=>{
  // Infrastructure test only. Adapter events are synthetic, not native/provider execution evidence.
  const base=mkdtempSync('/tmp/opencode/concurrency-');
  const git=(...args)=>execFileSync('git',args,{stdio:'pipe'});
  const root=join(base,'repo');mkdirSync(root);
  git('init','--initial-branch=main',root);git('-C',root,'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','fixture');
  const members=['admin','worker-1','worker-2'].map((role,i)=>{
    const directory=i?join(base,role):root,branch=i?role:'main';
    if(i)git('-C',root,'worktree','add','-b',branch,directory);
    return {role,sessionID:`ses_fixture_${i}`,directory,branch,agent:'build'};
  });
  const events=[],running=new Set(),gates=new Map(),submissions=[];
  let allStarted;
  const started=new Promise(resolve=>{allStarted=resolve});
  const ctx={location:{directory:root,project:{canonical:root,id:'project_fixture'}},options:{pilotStore:join(base,'store'),pilotWake:false,nativeDispatch:false},session:{
    get:async({sessionID})=>{const m=members.find(m=>m.sessionID===sessionID);return {id:m.sessionID,projectID:'project_fixture',agent:m.agent,location:{directory:m.directory}};},
    prompt:input=>{
      assert.ok(!submissions.some(s=>s.id===input.id));submissions.push(input);
      running.add(input.sessionID);events.push({sessionID:input.sessionID,type:'started',time:performance.now()});
      if(running.size===3)allStarted();
      return new Promise((resolve,reject)=>gates.set(input.sessionID,{resolve:()=>{running.delete(input.sessionID);events.push({sessionID:input.sessionID,type:'succeeded',time:performance.now()});resolve({id:input.id})},reject:reason=>{running.delete(input.sessionID);events.push({sessionID:input.sessionID,type:reason,time:performance.now()});reject(Error(reason))}}));
    }
  }};
  const coordinator=new OfficialCoordinator(ctx);
  // Admin entry represents independent Admin review; normal team_assign cannot assign Admin to itself.
  const messages=members.map((m,i)=>({id:`fixture_${i}`,action:'assign',to:m.role,taskID:`task_${i}`,text:'Controlled execution adapter fixture'}));
  coordinator.mutate(()=>({state:{status:'ready',projectID:'project_fixture',teamID:'team_fixture',members,messages,tasks:messages.map(m=>({id:m.taskID,assignee:m.to}))}}));
  const pending=messages.map(m=>coordinator.wake(m));
  let deadline;
  try{await Promise.race([started,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('GLOBAL_SERIALIZATION_OR_MISSING_START')),2000)})]);}finally{clearTimeout(deadline);}
  assert.equal(running.size,3);assert.equal(submissions.length,3);
  await Promise.all(messages.map(m=>coordinator.wake(m)));assert.equal(submissions.length,3);
  gates.get(members[1].sessionID).reject('failed');
  assert.equal(running.size,2);assert.ok(running.has(members[0].sessionID));
  gates.get(members[2].sessionID).reject('cancelled');
  assert.equal(running.size,1);assert.ok(running.has(members[0].sessionID));
  gates.get(members[0].sessionID).resolve();await Promise.all(pending);
  const starts=events.filter(e=>e.type==='started'),ends=events.filter(e=>e.type!=='started');
  assert.equal(starts.length,3);assert.equal(ends.length,3);
  assert.ok(Math.max(...starts.map(e=>e.time))<Math.min(...ends.map(e=>e.time)));
  const state=coordinator.read();assert.equal(state.messages[0].wake.status,'admitted');
  assert.equal(state.messages[1].wake.status,'uncertain');assert.equal(state.messages[2].wake.status,'uncertain');
  await Promise.all(messages.map(m=>coordinator.wake(m)));assert.equal(submissions.length,3);
  assert.equal(new Set(members.map(m=>m.directory)).size,3);assert.equal(new Set(messages.map(m=>m.taskID)).size,3);
  assert.equal(ctx.options.pilotWake,false);assert.equal(ctx.options.nativeDispatch,false);
});
