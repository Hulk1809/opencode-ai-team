import {mkdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {digest} from './broker.mjs';
// Directory must be broker-owned and agent-unwritable in deployment.
export function brokerArtifacts(directory){
  const check=hash=>{if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid artifact hash');return join(directory,hash);};
  const read=async hash=>{const file=await open(check(hash),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>32*1024*1024)throw Error('Artifact tampered');const bytes=await file.readFile();if(digest(bytes)!==hash)throw Error('Artifact tampered');return bytes;}finally{await file.close();}};
  const verify=async hash=>{await read(hash);};
  return {verify,read,put:async bytes=>{
    if(bytes.length>32*1024*1024)throw Error('Artifact too large');
    await mkdir(directory,{recursive:true,mode:0o700});const hash=digest(bytes);let file;
    try{file=await open(check(hash),'wx',0o400);await file.writeFile(bytes);await file.sync();}
    catch(error){if(error.code!=='EEXIST')throw error;}finally{await file?.close();}
    await verify(hash);return hash;
  }};
}
