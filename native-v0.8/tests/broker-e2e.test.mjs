import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,sign,X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {withBrokerLedger,digest} from '../src/broker.mjs';
import {brokerStore} from '../src/broker-store.mjs';
import {BuildJobs} from '../src/build-jobs.mjs';
import {BUILD_IMAGE} from '../src/build.mjs';
import {Workspace} from '../src/workspace.mjs';
import {brokerClient} from '../src/broker-client.mjs';
import {sourceRevision} from '../src/evidence.mjs';
const run=promisify(execFile);
const {createBrokerApplication}=await import(process.env.BROKER_TEST_SERVICE_URL??'../src/broker-service.mjs');

test('HTTP/mTLS signed approval traverses service/runtime/executor/jobs; spoof, tamper, replay, revoke and disconnect fail closed',async()=>{
  const root=await mkdtemp('/tmp/opencode/broker-e2e-'),certs={};
  // Ephemeral harness identities only; never installed credentials.
  for(const name of ['server','owner','admin','backend','qa','outsider']){
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${root}/${name}.key`,'-out',`${root}/${name}.crt`,'-days','1','-subj',`/CN=${name}`,'-addext',`subjectAltName=DNS:${name}`],{timeout:15000});
    certs[name]={key:await readFile(`${root}/${name}.key`),cert:await readFile(`${root}/${name}.crt`)};
  }
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const tree=`${root}/tree`;await mkdir(tree);await writeFile(`${tree}/pom.xml`,'<project/>');
  await run('git',['init',tree]);await run('git',['-C',tree,'add','pom.xml']);await run('git',['-C',tree,'-c','user.name=Harness','-c','user.email=harness@example.invalid','commit','-m','fixture']);
  const revision=(await sourceRevision(tree)).revision;
  const manifest=Buffer.from(JSON.stringify({projectID:'p',scopeID:'s',image:BUILD_IMAGE,inputs:[],tasks:['t','disconnected'].map(taskID=>({taskID,revision,acceptanceEpoch:0,snapshotHash:digest(JSON.stringify([{path:'pom.xml',sha256:digest(Buffer.from('<project/>'))}]))})),members:[{sessionID:'a',role:'admin'},{sessionID:'b',role:'backend',files:['pom.xml'],goals:['test']},{sessionID:'q',role:'qa',files:['pom.xml'],goals:['test']}]}));
  const envelope=(operation,nonce,epoch,expiresAt=Date.now()+60000)=>{
    const decision=Buffer.from(JSON.stringify({operation,nonce,epoch,expiresAt,projectID:'p',scopeID:'s',manifestHash:digest(manifest)}));
    return {decision:decision.toString('base64'),signature:sign(null,decision,privateKey).toString('base64'),manifest:manifest.toString('base64')};
  };
  let state={jobs:[]},creates=0,hold=false,releaseWait,enteredWait,failStop=true;const containers=new Map();
  const waiting=new Promise(resolve=>enteredWait=resolve);
  const jobs=new BuildJobs({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},docker:{
    create:async x=>{creates++;const mount=x.args.find(arg=>arg.startsWith('type=bind,src=')&&arg.endsWith(',dst=/workspace'));const directory=mount.slice('type=bind,src='.length,-',dst=/workspace'.length);await mkdir(`${directory}/target`);await writeFile(`${directory}/target/result.jar`,'simulated artifact');containers.set(x.name,{labels:x.labels,running:false});return x.name;},start:async id=>{containers.get(id).running=true;},wait:async id=>{if(hold){enteredWait();return new Promise(resolve=>releaseWait=resolve);}containers.get(id).running=false;return {exitCode:0};},logs:async()=>'controlled output',inspect:async id=>containers.get(id),stop:async id=>{if(failStop)throw Error('Injected stop failure');containers.get(id).running=false;},remove:async()=>{},
  }});
  await withBrokerLedger(root,async ledger=>{
    await mkdir(`${root}/requests`,{mode:0o700});
    const store=brokerStore(`${root}/requests`);let releaseDisconnect,disconnectEntered,disconnectBlocked=false;
    const disconnectSaving=new Promise(resolve=>disconnectEntered=resolve);
    const durableStore={...store,save:async value=>{
      await store.save(value);
      if(!disconnectBlocked&&value.requests.some(row=>row.input.requestID==='disconnect'&&row.state==='queued')){disconnectBlocked=true;disconnectEntered();await new Promise(resolve=>releaseDisconnect=resolve);}
    }};
    const policy=['owner','admin','backend','qa','outsider'].map(name=>({fingerprint:new X509Certificate(certs[name].cert).fingerprint256,kind:name==='owner'?'owner':name==='admin'?'admin':'agent',...(name==='owner'?{}:{projectID:name==='outsider'?'other':'p',sessionID:name==='admin'?'a':name==='qa'?'q':'b'})}));
    const app=await createBrokerApplication({tls:{...certs.server,ca:policy.map((_,i)=>certs[['owner','admin','backend','qa','outsider'][i]].cert)},policy,runtimeOptions:{ledger,ownerPublicKey:publicKey,store:durableStore,jobs,snapshotRoot:root,runRoot:root,cache:root,uid:1000,gid:1000,expiryMs:10}});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const send=(name,path,body,disconnect=false)=>new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:app.server.address().port,servername:'server',ca:certs.server.cert,...certs[name],method:'POST',path,headers:{'Content-Type':'application/json'},agent:false},res=>{
        if(disconnect){req.destroy();resolve(null);return;}
        let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));
      });req.on('error',reject);req.end(JSON.stringify(body));
    });
    const input={scopeID:'s',epoch:0,taskID:'t',goal:'test',files:[{path:'pom.xml',base64:Buffer.from('<project/>').toString('base64')}],requestID:'build'};
    try{
      assert.equal((await send('backend','/submit',input)).status,409);
      const approved=envelope('approve','approve',0);
      assert.equal((await send('owner','/approve',{...approved,manifest:Buffer.from('{}').toString('base64')})).status,409);
      assert.equal((await send('owner','/approve',envelope('approve','expired',0,Date.now()-1))).status,409);
      assert.equal((await send('owner','/approve',approved)).status,200);
      assert.equal((await send('owner','/approve',approved)).status,409);
      for(const field of ['projectID','sessionID'])assert.equal((await send('backend','/submit',{...input,[field]:'forged'})).status,400);
      assert.equal((await send('outsider','/submit',input)).status,409);
      assert.equal((await send('backend','/revoke',envelope('revoke','forged',1))).status,403);
      const build=await send('backend','/submit',input);assert.equal(build.status,200);await app.runtime.idle();
      const built=await send('backend','/status',{jobID:build.output.jobID});assert.equal(built.output.result.state,'succeeded');
      assert.equal((await send('qa','/status',{jobID:build.output.jobID})).status,409);
      assert.equal((await send('backend','/submit',input)).output.jobID,build.output.jobID);assert.equal(creates,1);
      assert.equal((await send('backend','/submit',{...input,goal:'verify'})).status,409);
      const qa=await send('qa','/submit',{...input,requestID:'qa',buildID:built.output.result.id});await app.runtime.idle();
      const checked=await send('qa','/status',{jobID:qa.output.jobID});assert.equal(checked.output.result.snapshotHash,built.output.result.snapshotHash);
      const done={revision,acceptanceEpoch:0,projectID:'p',scopeID:'s',taskID:'t',epoch:0,snapshotHash:built.output.result.snapshotHash,buildReceiptID:built.output.result.receiptID,qaReceiptID:checked.output.result.receiptID};
      assert.equal((await send('backend','/done',done)).status,403);assert.equal((await send('owner','/done',done)).status,403);assert.equal((await send('admin','/approve',approved)).status,403);
      assert.equal((await send('admin','/done',{...done,qaReceiptID:'fake'})).status,409);
      assert.equal((await send('admin','/done',{...done,snapshotHash:'stale'})).status,409);
      assert.equal((await send('admin','/done',{...done,qaReceiptID:done.buildReceiptID})).status,409);
      assert.equal((await send('admin','/done',{...done,epoch:1})).status,409);
      assert.equal((await send('admin','/done',{...done,taskID:'other-task'})).status,409);
      const artifactPath=`${root}/artifacts/${digest(Buffer.from('simulated artifact'))}`;
      const {chmod}=await import('node:fs/promises');await chmod(artifactPath,0o600);await writeFile(artifactPath,'tampered');
      assert.equal((await send('admin','/done',done)).status,409);await writeFile(artifactPath,'simulated artifact');await chmod(artifactPath,0o400);
      let team={status:'ready',members:{admin:{role:'admin',sessionID:'a'},backend:{role:'backend',sessionID:'b',directory:tree}},tasks:[{id:'t',assignee:'backend',status:'review',acceptanceEpoch:0,brokerBinding:done,dependencies:[],logs:[],reviews:[],outputAttachments:[]}],messages:[]};
      const room={read:async()=>structuredClone(team),write:async(_,value)=>{team=structuredClone(value);},exclusive:async(_,fn)=>fn(),controlEvent:()=>{}};
      const client=brokerClient({port:app.server.address().port,servername:'server',ca:certs.server.cert,...certs.admin});
      const host={identity:async()=>({projectID:'p',sessionID:'a',role:'admin'}),withFrozenRevision:async(_,__,fn)=>fn()};
      let loseResponse=true,failWrite=true,failPrepared=true,failFinal=true,submits=0;
      const recoveringClient={...client,done:async binding=>{submits++;const result=await client.done(binding);if(loseResponse){loseResponse=false;throw Error('Injected lost response');}return result;}};
      const write=room.write;room.write=async(directory,value)=>{const state=value.tasks[0].completionJournal?.state;if(failPrepared&&state==='prepared'){failPrepared=false;throw Error('Injected prepared write failure');}if(failWrite&&state==='broker_committed'){failWrite=false;throw Error('Injected plugin write failure');}if(failFinal&&state==='committed'){failFinal=false;throw Error('Injected final write failure');}return write(directory,value);};
      const workspace=new Workspace({},room,recoveringClient,host);
      await assert.rejects(new Workspace({},room,client).execute(tree,'a','update',{taskID:'t',status:'done'}),/trusted host identity/);
      assert.equal((await client.taskPolicy({taskID:'t'})).kind,'protected');
      await assert.rejects(client.taskPolicy({taskID:'unknown'}),/rejected/);
      const savedTask=structuredClone(team.tasks[0]);
      for(const key of ['brokerBinding','buildEvidence','qaEvidence'])delete team.tasks[0][key];
      for(const key of ['codingScope','buildEnvironment'])delete team.members.backend[key];
      for(const action of ['update','review','blocker'])await assert.rejects(new Workspace({},room,client).execute(tree,'a',action,{taskID:'t',status:'done'}),/no legacy fallback/);
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/Authoritative task binding/);
      team.tasks[0]=savedTask;
      await assert.rejects(new Workspace({},room,client,{...host,identity:async()=>({projectID:'other',sessionID:'a',role:'admin'})}).execute(tree,'a','update',{taskID:'t',status:'done'}),/Authenticated/);
      await assert.rejects(new Workspace({},room,client,{...host,identity:async()=>({projectID:'p',sessionID:'b',role:'admin'})}).execute(tree,'a','update',{taskID:'t',status:'done'}),/Authenticated/);
      for(const input of [{...done,projectID:'other'},{...done,acceptanceEpoch:1},{...done,epoch:1}])assert.equal((await send('admin','/completionStatus',input)).status,409);
      await writeFile(`${tree}/pom.xml`,'changed');await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/revision/);assert.equal(team.tasks[0].status,'review');await writeFile(`${tree}/pom.xml`,'<project/>');
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/prepared write failure/);assert.equal(submits,0);
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/lost response/);assert.equal(team.tasks[0].status,'review');
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/plugin write failure/);assert.equal(team.tasks[0].status,'review');
      const racing=new Workspace({},room,{...client,completionStatus:async binding=>{const result=await client.completionStatus(binding);await writeFile(`${tree}/pom.xml`,'race');return result;}},host);
      await assert.rejects(racing.execute(tree,'a','update',{taskID:'t',status:'done'}),/Frozen revision changed/);assert.equal(team.tasks[0].status,'review');await writeFile(`${tree}/pom.xml`,'<project/>');
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'done'}),/final write failure/);assert.equal(team.tasks[0].completionJournal.state,'broker_committed');assert.equal(team.tasks[0].status,'review');
      await workspace.execute(tree,'a','update',{taskID:'t',status:'done'});assert.equal(team.tasks[0].status,'done');assert.equal(team.tasks[0].brokerCompletion.adminSessionID,'a');assert.equal(submits,1);
      await workspace.execute(tree,'a','update',{taskID:'t',status:'done'});assert.equal(submits,1);
      await assert.rejects(workspace.execute(tree,'a','update',{taskID:'t',status:'working'}),/reopen/);
      for(const action of ['blocker','review'])await assert.rejects(workspace.execute(tree,'a',action,{taskID:'t'}),/reopen/);
      await chmod(artifactPath,0o600);await writeFile(artifactPath,'tampered');assert.equal((await send('admin','/completionStatus',done)).status,409);await writeFile(artifactPath,'simulated artifact');await chmod(artifactPath,0o400);
      assert.equal((await send('admin','/done',done)).status,409);
      let headers=false;
      const disconnected=request({host:'127.0.0.1',port:app.server.address().port,servername:'server',ca:certs.server.cert,...certs.backend,method:'POST',path:'/submit',agent:false,headers:{'Content-Type':'application/json'}},()=>{headers=true;});
      disconnected.on('error',()=>{});disconnected.end(JSON.stringify({...input,taskID:'disconnected',requestID:'disconnect'}));
      await disconnectSaving;disconnected.destroy();assert.equal(headers,false);releaseDisconnect();
      const retry=await send('backend','/submit',{...input,taskID:'disconnected',requestID:'disconnect'});await app.runtime.idle();assert.equal(retry.status,200);assert.equal(creates,3);
      hold=true;const active=await send('backend','/submit',{...input,requestID:'running-revoke'});await waiting;
      assert.equal((await send('owner','/revoke',envelope('revoke','revoke',1))).status,409);
      assert.equal((await send('backend','/status',{jobID:active.output.jobID})).output.state,'uncertain');
      failStop=false;await app.runtime.expire();releaseWait({exitCode:0});await app.runtime.idle();
      assert.equal((await send('backend','/status',{jobID:active.output.jobID})).output.state,'revoked');
      assert.equal((await send('backend','/submit',{...input,requestID:'after-revoke'})).status,409);
      assert.equal((await send('admin','/completionStatus',done)).status,409);
    }finally{await new Promise(r=>app.server.close(r));await app.runtime.close();}
  },publicKey);
});
