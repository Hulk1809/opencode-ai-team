import {open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
// Caller holds process-lifetime kernel lock; mutations serialized by broker-control.
export function brokerStore(directory,{commitCheckpoint=async()=>{}}={}){
  const path=join(directory,'requests.json');
  return {
    load:async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {scopes:{},requests:[]};}},
    save:async state=>{
      const tmp=join(directory,`requests-${randomUUID()}.tmp`),file=await open(tmp,'wx',0o600);
      try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
      // Trusted fault-harness injection only; never request/config controlled.
      await commitCheckpoint('before-rename',state);
      await rename(tmp,path);await commitCheckpoint('after-rename',state);
      const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
    },
  };
}
