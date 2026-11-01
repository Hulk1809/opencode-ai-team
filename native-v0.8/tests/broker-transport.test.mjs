import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {createBrokerServer} from '../src/broker-transport.mjs';
const run=promisify(execFile);
test('real mTLS transport rejects unknown peer, role/session spoofing and Owner operations from agent',async t=>{
  const root=await mkdtemp('/tmp/opencode/broker-tls-');
  // Ephemeral test-only certificates, not Owner identity or installed trust anchors.
  const certs={};
  for(const name of ['server','agent','owner','unknown']){
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${root}/${name}.key`,'-out',`${root}/${name}.crt`,'-days','1','-subj',`/CN=${name}`,'-addext',`subjectAltName=DNS:${name}`],{timeout:15000});
    certs[name]={key:await readFile(`${root}/${name}.key`),cert:await readFile(`${root}/${name}.crt`)};
  }
  const calls=[];
  const server=createBrokerServer({tls:{...certs.server,ca:[certs.agent.cert,certs.owner.cert,certs.unknown.cert]},policy:[{fingerprint:new X509Certificate(certs.agent.cert).fingerprint256,kind:'agent',projectID:'project-one',sessionID:'backend-one'},{fingerprint:new X509Certificate(certs.owner.cert).fingerprint256,kind:'owner'}],handlers:{submit:async(peer,input)=>{calls.push({peer,input});return {jobID:'job-one'};},status:async(peer)=>({projectID:peer.projectID}),view:async()=>({scopes:[]})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const send=(name,path,body)=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,servername:'server',ca:certs.server.cert,...certs[name],method:'POST',path,headers:{'Content-Type':'application/json'},agent:false},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});
  const input={scopeID:'scope',epoch:0,taskID:'task',goal:'test',files:[],requestID:'request-one'};
  assert.equal((await send('agent','/submit',input)).status,200);assert.equal(calls[0].peer.sessionID,'backend-one');assert.equal(calls[0].peer.projectID,'project-one');
  assert.equal((await send('agent','/submit',{...input,sessionID:'qa'})).status,400);
  assert.equal((await send('agent','/submit',{...input,projectID:'other'})).status,400);
  assert.equal((await send('agent','/approve',{})).status,403);
  assert.equal((await send('agent','/view',{})).status,403);
  assert.equal((await send('owner','/view',{})).status,200);
  assert.equal((await send('owner','/submit',input)).status,403);
  assert.equal((await send('unknown','/status',{jobID:'job-one'})).status,400);
  assert.equal(calls.length,1);
});
