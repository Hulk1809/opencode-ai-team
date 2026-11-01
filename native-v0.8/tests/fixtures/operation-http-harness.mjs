import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {fixture} from './operation-fixture.mjs';
import {createBrokerApplication} from '../../src/broker-service.mjs';
const run=promisify(execFile);
export const names=['server','owner','admin','backend','qa','devops','outsider','unknown'];
export async function certificates(root){
  for(const name of names)await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${root}/${name}.key`,'-out',`${root}/${name}.crt`,'-days','1','-subj',`/CN=${name}`,'-addext',`subjectAltName=DNS:${name}`],{timeout:15000});
}
export async function loadCertificates(root){return Object.fromEntries(await Promise.all(names.map(async name=>[name,{key:await readFile(`${root}/${name}.key`),cert:await readFile(`${root}/${name}.crt`)}])));}
export async function application(directory,certs,{isolatedOperations=true,saveHook,beforeSave,store,configure=()=>{}}={}){
  const f=await fixture(directory,{saveHook,beforeSave,recover:false});
  await configure(f);
  const policy=names.filter(n=>!['server','unknown'].includes(n)).map(name=>({fingerprint:new X509Certificate(certs[name].cert).fingerprint256,kind:name==='owner'?'owner':name==='admin'?'admin':'agent',role:name==='outsider'?'qa':name,projectID:name==='outsider'?'other':'synthetic',sessionID:name,principalID:'principal_'+name}));
  const app=await createBrokerApplication({tls:{...certs.server,ca:names.filter(n=>n!=='server').map(n=>certs[n].cert)},policy,isolatedOperations,runtimeOptions:{...f.options,store:store??{load:f.options.load,save:f.options.save},jobs:{recover:async()=>{},load:async()=>({jobs:[]})},snapshotRoot:directory,runRoot:directory,cache:directory,expiryMs:60000}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  return {...f,...app,port:app.server.address().port,close:async()=>{await new Promise(r=>app.server.close(r));await app.runtime.close();}};
}
export function send(certs,port,name,path,body,{dropResponse=false}={}){return new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,servername:'server',ca:certs.server.cert,...certs[name],method:'POST',path,headers:{'Content-Type':'application/json'},agent:false},res=>{if(dropResponse){req.destroy();resolve(null);return;}let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(data)}));});
  req.on('error',reject);req.end(JSON.stringify(body));
});}
export function disconnect(certs,port,name,path,body){
  const req=request({host:'127.0.0.1',port,servername:'server',ca:certs.server.cert,...certs[name],method:'POST',path,headers:{'Content-Type':'application/json'},agent:false});
  req.on('error',()=>{});req.end(JSON.stringify(body));return req;
}
