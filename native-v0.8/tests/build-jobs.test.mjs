import test from 'node:test';
import assert from 'node:assert/strict';
import {BuildJobs,withBuildJobs,dockerAdapter} from '../src/build-jobs.mjs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {BUILD_IMAGE} from '../src/build.mjs';
const scope={id:'scope',image:BUILD_IMAGE,directory:'/fixture/worktree',cache:'/fixture/cache',goals:['test','verify'],uid:1000,gid:1000};
test('durable jobs survive reopen; independent writers cannot admit concurrently; real adapter argv stays fixed',async()=>{
  const directory=await mkdtemp('/tmp/opencode/durable-build-');
  const calls=[];let labels;
  const adapter=dockerAdapter(async(file,args)=>{
    calls.push({file,args});
    if(args[0]==='create'){labels={'ai-team.job':args[args.indexOf('--label')+1].split('=')[1],'ai-team.scope':scope.id};return {stdout:'container\n'};}
    if(args[0]==='wait')return {stdout:'0\n'};
    if(args[0]==='inspect')return {stdout:JSON.stringify([{Config:{Labels:labels},State:{Running:false,ExitCode:0}}])};
    return {stdout:args[0]==='logs'?'BUILD SUCCESS':''};
  });
  await withBuildJobs(directory,async jobs=>{
    await assert.rejects(withBuildJobs(directory,async()=>{}),{code:'EEXIST'});
    const job=await jobs.enqueue(scope,'task','verify');
    const result=await jobs.start(job.id,scope);assert.equal(result.state,'succeeded');assert.ok(result.cleanedAt);
  },adapter);
  await withBuildJobs(directory,async jobs=>{const state=await jobs.load();assert.equal(state.jobs[0].output,'BUILD SUCCESS');assert.ok(state.jobs[0].cleanedAt);},adapter);
  assert.equal(JSON.parse(await readFile(`${directory}/jobs.json`)).jobs.length,1);
  assert.ok(calls.every(c=>c.file==='/usr/bin/docker'));
  assert.ok(calls.some(c=>c.args[0]==='rm'&&c.args[1]==='container'));
  assert.ok(!calls.some(c=>c.args.includes('--rm')));
});
test('job timeout verifies stop/ownership; uncertain job cannot replay; revoke blocks admission',async()=>{
  let state={jobs:[]},labels,running=true,stopped=0,removed=0;
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{create:async x=>{labels=x.labels;return 'container';},start:async()=>{},wait:async()=>{throw Object.assign(Error('deadline'),{code:'TIMEOUT'});},inspect:async()=>({labels,running}),stop:async()=>{stopped++;running=false;},remove:async()=>{removed++;}}});
  const job=await jobs.enqueue(scope,'task','verify');
  assert.equal((await jobs.start(job.id,scope)).state,'timeout');assert.equal(stopped,1);assert.equal(removed,1);
  state.jobs[0].state='uncertain';await assert.rejects(jobs.enqueue(scope,'task','verify'),/no replay/);
  await jobs.revoke(scope.id);await assert.rejects(jobs.enqueue(scope,'other','test'),/revoked/);
  delete state.jobs[0].cleanedAt;labels={'ai-team.job':'foreign'};await assert.rejects(jobs.reconcile(job.id,true),/ownership/);assert.equal(removed,1);
});
test('failed stop verification retains uncertain job and never removes running container',async()=>{
  let state={jobs:[]},labels,removed=0;
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},maxJobs:1,docker:{create:async x=>{labels=x.labels;return 'container';},start:async()=>{},wait:async()=>{throw Object.assign(Error('deadline'),{code:'TIMEOUT'});},inspect:async()=>({labels,running:true}),stop:async()=>{},remove:async()=>{removed++;}}});
  const job=await jobs.enqueue(scope,'task','test');
  assert.equal((await jobs.start(job.id,scope)).state,'uncertain');assert.equal(removed,0);
  await assert.rejects(jobs.start(job.id,scope),/not admissible/);
  await assert.rejects(jobs.enqueue(scope,'other','verify'),/concurrency/);
});
test('crash recovery stops owned job without replay; revoke stops active and queued jobs',async()=>{
  let state={jobs:[{id:'old',scopeID:'scope',state:'running',containerID:'old-container'}]},running=true,removed=0;
  const docker={inspect:async()=>({labels:{'ai-team.job':'old','ai-team.scope':'scope'},running}),stop:async()=>{running=false;},remove:async()=>{removed++;}};
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker});
  await jobs.recover();assert.equal(state.jobs[0].state,'interrupted');assert.equal(removed,1);await jobs.recover();assert.equal(removed,1);
  state={jobs:[{id:'old',scopeID:'scope',state:'running',containerID:'old-container'},{id:'queued',scopeID:'scope',state:'queued'}]};running=true;
  await jobs.revoke('scope');assert.equal(state.jobs[0].state,'revoked');assert.ok(state.jobs[0].cleanedAt);assert.equal(state.jobs[1].state,'revoked');
  await assert.rejects(jobs.enqueue(scope,'new','test'),/revoked/);
});
test('revocation during wait cannot be overwritten by late successful completion',async()=>{
  let state={jobs:[]},labels,running=true,release,waiting;
  const entered=new Promise(r=>{waiting=r;});
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{create:async x=>{labels=x.labels;return 'container';},start:async()=>{},wait:async()=>{waiting();return new Promise(r=>{release=r;});},inspect:async()=>({labels,running}),stop:async()=>{running=false;},remove:async()=>{}}});
  const job=await jobs.enqueue(scope,'task','test'),execution=jobs.start(job.id,scope);await entered;
  await jobs.revoke(scope.id);release({exitCode:0});const result=await execution;
  assert.equal(result.state,'revoked');assert.ok(result.cleanedAt);assert.ok(state.revokedScopes.includes(scope.id));
});

test('revoke during create waits for identity then stops before late completion; state never loses revocation',async()=>{
  let state={jobs:[]},labels,running=false,created,releaseCreate,waiting,releaseWait,removed=0;
  const creating=new Promise(r=>created=r),entered=new Promise(r=>waiting=r);
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{
    create:async x=>{labels=x.labels;created();await new Promise(r=>releaseCreate=r);return 'container';},
    start:async()=>{running=true;},wait:async()=>{waiting();return new Promise(r=>releaseWait=r);},
    inspect:async()=>({labels,running}),stop:async()=>{running=false;},remove:async()=>{removed++;},
  }});
  const job=await jobs.enqueue(scope,'task','test'),execution=jobs.start(job.id,scope);await creating;
  const revoked=jobs.revoke(scope.id);releaseCreate();await entered;await revoked;
  assert.equal(running,false);assert.equal(removed,1);releaseWait({exitCode:0});
  assert.equal((await execution).state,'revoked');assert.ok(state.revokedScopes.includes(scope.id));
});

test('approval invalidated during create prevents container start and preserves reconciliation identity',async()=>{
  let state={jobs:[]},valid=true,starts=0,labels;
  const guarded={...scope,authorize:()=>{if(!valid)throw Error('Approval expired');}};
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{
    create:async x=>{labels=x.labels;valid=false;return 'container';},start:async()=>{starts++;},
    inspect:async()=>({labels,running:false}),remove:async()=>{},
  }});
  const job=await jobs.enqueue(guarded,'task','test');
  await assert.rejects(jobs.start(job.id,guarded),/Approval expired/);assert.equal(starts,0);
  assert.equal(state.jobs[0].state,'uncertain');assert.equal(state.jobs[0].containerID,'container');
  await jobs.recover();assert.equal(state.jobs[0].state,'interrupted');assert.ok(state.jobs[0].cleanedAt);
});
