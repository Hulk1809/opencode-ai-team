// Deploy only as reviewed, agent-unwritable code under a separate OS identity.
import {createHash,verify} from 'node:crypto';
import {mkdir,open,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identifier=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(x);
export function verifyDecision(bytes,signature,key,manifest,now=Date.now()){
  if(!Buffer.isBuffer(bytes)||bytes.length>16384||!verify(null,bytes,key,signature))throw Error('Invalid Owner signature');
  const d=JSON.parse(bytes.toString());
  if(Object.keys(d).sort().join(',')!=='epoch,expiresAt,manifestHash,nonce,operation,projectID,scopeID'||
    !['approve','revoke'].includes(d.operation)||![d.projectID,d.scopeID,d.nonce].every(identifier)||
    !Number.isSafeInteger(d.epoch)||d.epoch<0||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=now||
    d.manifestHash!==digest(manifest))throw Error('Invalid approval binding');
  return d;
}
// One process owns ledger. Exclusive lock intentionally requires administrator recovery after crash.
export async function withBrokerLedger(directory,callback,ownerPublicKey,{externallyFenced=false}={}){
  await mkdir(directory,{recursive:true,mode:0o700});
  const lock=externallyFenced?null:await open(join(directory,'broker.lock'),'wx',0o600);
  try{
    let state;try{state=JSON.parse(await readFile(join(directory,'ledger.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={nonces:[],scopes:{},audit:[]};}
    const save=async()=>{
      const f=await open(join(directory,'ledger.tmp'),'w',0o600);
      try{await f.writeFile(JSON.stringify(state));await f.sync();}finally{await f.close();}
      await rename(join(directory,'ledger.tmp'),join(directory,'ledger.json'));
      const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
    };
    return await callback({
      view:()=>structuredClone(state),
      apply:async(bytes,signature,manifest)=>{
        const d=verifyDecision(bytes,signature,ownerPublicKey,manifest);
        const key=JSON.stringify([d.projectID,d.scopeID]),old=state.scopes[key];
        if(state.nonces.includes(d.nonce))throw Error('Decision replay');
        if(d.operation==='approve'?(d.epoch!==(old?.epoch??0)):(!old||d.epoch!==old.epoch+1))throw Error('Revocation epoch mismatch');
        if(d.operation==='approve'&&old?.revoked)throw Error('Revoked scope needs new scope ID');
        state.nonces.push(d.nonce);state.scopes[key]={...d,revoked:d.operation==='revoke'};
        state.audit.push({...d,at:Date.now()});await save();
      },
      authorize:(projectID,scopeID,manifestHash,epoch,now=Date.now())=>{
        const s=state.scopes[JSON.stringify([projectID,scopeID])];
        if(!s||s.revoked||s.manifestHash!==manifestHash||s.epoch!==epoch||s.expiresAt<=now)throw Error('Scope denied');
        return structuredClone(s);
      },
    });
  }finally{if(lock){await lock.close();const {unlink}=await import('node:fs/promises');await unlink(join(directory,'broker.lock'));}}
}
