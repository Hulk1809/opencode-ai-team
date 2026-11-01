import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {brokerRuntime} from '../src/broker-runtime.mjs';
import {BuildJobs} from '../src/build-jobs.mjs';
import {BUILD_IMAGE} from '../src/build.mjs';
import {digest} from '../src/broker.mjs';
import {createBrokerApplication} from '../src/broker-service.mjs';

test('isolated control/executor/BuildJobs pipeline binds backend and independent QA snapshots',async()=>{
  const root=await mkdtemp('/tmp/opencode/runtime-'),files=[{path:'pom.xml',base64:Buffer.from('<project/>').toString('base64')}];
  const manifest=JSON.stringify({projectID:'p',scopeID:'s',image:BUILD_IMAGE,inputs:[{path:'pom.xml',sha256:digest(Buffer.from('<project/>'))}],members:[{sessionID:'b',role:'backend',files:[],goals:['test']},{sessionID:'q',role:'qa',files:[],goals:['test']}]});
  let state={scopes:{'["p","s"]':{manifest}},requests:[]},jobState={jobs:[]};const containers=new Map();let creates=0;
  const jobs=new BuildJobs({load:async()=>structuredClone(jobState),save:async s=>{jobState=structuredClone(s);},docker:{create:async x=>{creates++;containers.set(x.name,{labels:x.labels,running:false});return x.name;},start:async()=>{},wait:async()=>({exitCode:0}),inspect:async id=>containers.get(id),remove:async()=>{},logs:async()=>'controlled test evidence'}});
  const ledger={authorize:(project,scope,hash)=>{assert.equal(project,'p');assert.equal(scope,'s');assert.equal(hash,digest(Buffer.from(manifest)));}};
  const runtime=await brokerRuntime({ledger,store:{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}},jobs,snapshotRoot:root,runRoot:root,cache:root,uid:1000,gid:1000});
  try{
    const input={requestID:'build',scopeID:'s',epoch:0,taskID:'t',goal:'test',files};
    const build=await runtime.handlers.submit({projectID:'p',sessionID:'b'},input);await runtime.idle();
    const result=await runtime.handlers.status({projectID:'p',sessionID:'b'},{jobID:build.jobID});assert.equal(result.state,'finished');assert.equal(result.result.state,'succeeded');
    const qa=await runtime.handlers.submit({projectID:'p',sessionID:'q'},{...input,requestID:'qa',buildID:result.result.id});await runtime.idle();
    const checked=await runtime.handlers.status({projectID:'p',sessionID:'q'},{jobID:qa.jobID});assert.equal(checked.result.snapshotHash,result.result.snapshotHash);assert.equal(checked.result.buildID,result.result.id);assert.equal(creates,2);
    await runtime.handlers.submit({projectID:'p',sessionID:'b'},input);await runtime.idle();assert.equal(creates,2);
    await assert.rejects(runtime.handlers.submit({projectID:'other',sessionID:'b'},input),/manifest/);
  }finally{await runtime.close();}
});

test('service composition enforces periodic expiry during wait and preserves failed-stop uncertainty',async()=>{
  const root=await mkdtemp('/tmp/opencode/runtime-expiry-');
  const manifest=JSON.stringify({projectID:'p',scopeID:'s',image:BUILD_IMAGE,inputs:[],members:[{sessionID:'b',role:'backend',files:['pom.xml'],goals:['test']}]});
  let state={scopes:{'["p","s"]':{manifest}},requests:[]},jobState={jobs:[]},valid=true,failStop=true,release,entered;
  const started=new Promise(resolve=>entered=resolve),containers=new Map();let removes=0;
  const jobs=new BuildJobs({load:async()=>structuredClone(jobState),save:async s=>{jobState=structuredClone(s);},docker:{
    create:async x=>{containers.set(x.name,{labels:x.labels,running:false});return x.name;},
    start:async id=>{containers.get(id).running=true;},wait:async()=>{entered();return new Promise(resolve=>release=resolve);},
    inspect:async id=>structuredClone(containers.get(id)),stop:async id=>{if(failStop)throw Error('Injected stop failure');containers.get(id).running=false;},
    remove:async()=>{removes++;},logs:async()=>'late success',
  }});
  const app=await createBrokerApplication({tls:{},policy:[{kind:'owner',fingerprint:Array(32).fill('00').join(':')}],runtimeOptions:{ledger:{authorize:()=>{if(!valid)throw Error('Scope denied');}},store:{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}},jobs,snapshotRoot:root,runRoot:root,cache:root,uid:1000,gid:1000,expiryMs:10}});
  const peer={projectID:'p',sessionID:'b'};
  const until=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for periodic expiry');await new Promise(r=>setTimeout(r,5));}};
  try{
    const job=await app.runtime.handlers.submit(peer,{requestID:'expiry',scopeID:'s',epoch:0,taskID:'t',goal:'test',files:[{path:'pom.xml',base64:Buffer.from('<project/>').toString('base64')}]});
    await started;valid=false;
    await until(()=>state.requests[0].state==='uncertain');assert.equal(removes,0);assert.equal(app.runtime.health().expiryError,'Expiry stop unverified');
    failStop=false;await until(()=>state.requests[0].state==='expired');assert.equal(removes,1);
    release({exitCode:0});await app.runtime.idle();
    const result=await app.runtime.handlers.status(peer,{jobID:job.jobID});assert.equal(result.state,'expired');assert.equal(result.result,undefined);
  }finally{release?.({exitCode:0});await app.runtime.close();}
});

test('runtime denies admission until crash reconciliation; never replays queued or uncertain jobs',async()=>{
  let calls=0,state={jobs:[{id:'old',state:'uncertain',scopeID:'s'}]};
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{create:async()=>{calls++;}}});
  await assert.rejects(brokerRuntime({jobs}),/Missing container identity/);assert.equal(calls,0);
  state={jobs:[{id:'queued',state:'queued',scopeID:'s'}]};
  await assert.rejects(brokerRuntime({jobs}),/Unreconciled jobs/);assert.equal(calls,0);
});

test('shutdown closes admission and verifies owned running container stop before returning',async()=>{
  const root=await mkdtemp('/tmp/opencode/shutdown-');
  const manifest=JSON.stringify({projectID:'p',scopeID:'s',image:BUILD_IMAGE,inputs:[],members:[{sessionID:'b',role:'backend',files:['pom.xml'],goals:['test']}]});
  let state={scopes:{'["p","s"]':{manifest}},requests:[]},jobState={jobs:[]},labels,running=false,release,entered,stops=0;
  const started=new Promise(r=>entered=r);
  const jobs=new BuildJobs({load:async()=>structuredClone(jobState),save:async s=>{jobState=structuredClone(s);},docker:{
    create:async x=>{labels=x.labels;return 'container';},start:async()=>{running=true;},wait:async()=>{entered();return new Promise(r=>release=r);},
    inspect:async()=>({labels,running}),stop:async()=>{stops++;running=false;release({exitCode:137});},remove:async()=>{},
  }});
  const runtime=await brokerRuntime({ledger:{authorize:()=>{}},store:{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}},jobs,snapshotRoot:root,runRoot:root,cache:root,uid:1000,gid:1000});
  const peer={projectID:'p',sessionID:'b'},input={requestID:'shutdown',scopeID:'s',epoch:0,taskID:'t',goal:'test',files:[{path:'pom.xml',base64:Buffer.from('<project/>').toString('base64')}]};
  await runtime.handlers.submit(peer,input);await started;await runtime.close();
  assert.equal(stops,1);assert.equal(running,false);assert.ok(jobState.jobs[0].cleanedAt);assert.equal(state.requests[0].state,'interrupted');
  await assert.rejects(runtime.handlers.submit(peer,{...input,requestID:'late'}),/Runtime closed/);
});
