import {open,mkdir,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {digest} from './broker.mjs';
const valid=p=>typeof p==='string'&&p.length<1024&&!p.includes('\\')&&!p.includes('\0')&&!p.startsWith('/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&s!=='.git');
// Input is a bounded file envelope, never a host path supplied by worker.
export async function createSnapshot(parent,files){
  if(!Array.isArray(files)||!files.length||files.length>5000)throw Error('Invalid snapshot files');
  const names=new Set();let total=0;
  const rows=files.map(f=>{
    if(!valid(f.path)||names.has(f.path)||typeof f.base64!=='string')throw Error('Invalid snapshot path');
    names.add(f.path);const bytes=Buffer.from(f.base64,'base64');
    if(bytes.toString('base64')!==f.base64||(total+=bytes.length)>32*1024*1024)throw Error('Invalid snapshot content/size');
    return {path:f.path,bytes,sha256:digest(bytes)};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  const inventory=rows.map(({path,sha256})=>({path,sha256})),hash=digest(JSON.stringify(inventory));
  const {mkdtemp}=await import('node:fs/promises');
  const directory=await mkdtemp(join(parent,`${hash}-`));
  for(const f of rows){await mkdir(join(directory,f.path,'..'),{recursive:true,mode:0o700});const out=await open(join(directory,f.path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{await out.writeFile(f.bytes);await out.sync();}finally{await out.close();}}
  await chmod(directory,0o500);return {directory,hash,inventory};
}
export async function verifySnapshot(snapshot){
  for(const f of snapshot.inventory)if(!valid(f.path)||digest(await readFile(join(snapshot.directory,f.path)))!==f.sha256)throw Error('Snapshot changed');
  if(digest(JSON.stringify(snapshot.inventory))!==snapshot.hash)throw Error('Snapshot inventory changed');
}
