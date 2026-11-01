// Trusted installation entry point. Diagnostic service only until execution gates pass.
import {fstatSync} from 'node:fs';
import {readFile as read} from 'node:fs/promises';
import {withBrokerLedger} from './broker.mjs';
import {brokerControl} from './broker-control.mjs';
import {brokerStore} from './broker-store.mjs';
import {createBrokerServer} from './broker-transport.mjs';
import {brokerRuntime} from './broker-runtime.mjs';
import {pathToFileURL} from 'node:url';
// Internal injection supports isolated service tests, never request/config activation.
export async function createBrokerApplication({tls,policy,runtimeOptions,isolatedOperations=false}){
  if(isolatedOperations&&!runtimeOptions.operations)throw Error('Isolated operation adapters required');
  const runtime=await brokerRuntime(runtimeOptions);
  try{return {server:createBrokerServer({tls,policy,handlers:runtime.handlers,isolatedOperations}),runtime};}
  catch(error){await runtime.close();throw error;}
}
export async function diagnosticMain(){
const config=JSON.parse(await read(process.argv[2],'utf8'));
const fd=Number(process.env.AI_TEAM_LOCK_FD);
if(!Number.isSafeInteger(fd)||fd<3)throw Error('Kernel-fenced launcher required');
const stat=fstatSync(fd),locks=await read('/proc/locks','utf8');
if(!locks.split('\n').some(line=>{const p=line.trim().split(/\s+/);return p[1]==='FLOCK'&&p[3]==='WRITE'&&p[4]===String(process.pid)&&p[5]?.split(':').at(-1)===String(stat.ino);}))throw Error('Missing live kernel fence');
if(config.host!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('Invalid broker listener');
const key=await read(config.ownerPublicKey),store=brokerStore(config.stateDirectory);
await withBrokerLedger(config.stateDirectory,async ledger=>{
  const control=brokerControl({ledger,ownerPublicKey:key,...store,
    execute:async()=>{throw Error('Execution activation disabled pending security acceptance');},
     stopScope:async()=>{const state=await store.load();if(state.requests.some(r=>['running','stopping','uncertain'].includes(r.state)))throw Error('Running executor unavailable; reconcile before revoke completion');},
  });
  await control.recover();
  const server=createBrokerServer({tls:{key:await read(config.tlsKey),cert:await read(config.tlsCert),ca:await read(config.clientCA)},policy:config.identities,handlers:control.handlers});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  await new Promise(resolve=>{const stop=()=>server.close(resolve);process.once('SIGTERM',stop);process.once('SIGINT',stop);});
  await control.idle();
},key,{externallyFenced:true});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await diagnosticMain();
