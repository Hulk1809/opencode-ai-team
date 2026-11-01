import {application,loadCertificates} from './operation-http-harness.mjs';
import {brokerStore} from '../../src/broker-store.mjs';
const [root,directory,point]=process.argv.slice(2);
const store=brokerStore(directory,{commitCheckpoint:async(stage,state)=>{
  if(stage===point&&state.operationAudit?.at(-1)?.type==='effect-intent'){
    process.send({checkpoint:stage});await new Promise(()=>{});
  }
}});
const app=await application(directory,await loadCertificates(root),{store});
process.on('message',async message=>{
  if(message==='execute')await app.runtime.operations.execute(Object.keys((await store.load()).operations)[0]);
});
process.send({port:app.port,owner:app.signed('approve'),input:app.request()});
