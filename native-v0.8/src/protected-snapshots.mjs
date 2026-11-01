// Adapted from Phase1.8 offline kit. Integrity checks, NOT a same-UID OS boundary.
import {open,lstat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,parse,join} from 'node:path';
import {digest} from './broker.mjs';
import {canonical} from './broker-operations.mjs';

const check=(ok,message)=>{if(!ok)throw Error(message);};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const keys=['projectID','taskID','revision','acceptanceEpoch','repository','repositoryID','branch','baseCommit','authorSessionID','authorPrincipalID'];
export function sourcePath(p){
  check(typeof p==='string'&&p.length<=1024&&p.split('/').every(s=>/^[A-Za-z0-9_.-]+$/.test(s)&&s!=='.'&&s!=='..'&&s!=='.git')&&!p.includes('\\'),'Unsafe source path');return p;
}
export async function realDirectory(directory){
  const absolute=resolve(directory);let current=parse(absolute).root;
  for(const part of absolute.slice(current.length).split('/').filter(Boolean)){current=join(current,part);const s=await lstat(current);check(s.isDirectory()&&!s.isSymbolicLink(),'Unsafe parent directory');}
}
async function readSource(path){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const a=await file.stat({bigint:true});check(a.isFile()&&a.nlink===1n,'Unsafe source type/hardlink');
    check(a.size<=2n*1024n*1024n,'Source file too large');check((a.mode&0o7111n)===0n&&(a.mode&0o022n)===0n,'Unsafe source mode');
    const bytes=await file.readFile(),b=await file.stat({bigint:true});
    check(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(k=>a[k]===b[k])&&bytes.length===Number(a.size),'Concurrent source change');return bytes;
  }finally{await file.close();}
}
function filesValid(files){
  check(Array.isArray(files)&&files.length<=2000,'Invalid source files');let total=0,previous='';
  for(const f of files){sourcePath(f.path);check(f.path>previous&&f.mode==='100644'&&hash(f.sha256)&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=2*1024*1024,'Invalid source entry/mode');previous=f.path;total+=f.size;}
  check(total<=16*1024*1024,'Source tree too large');
}
function changes(base,files){
  const a=new Map(base.map(f=>[f.path,f])),b=new Map(files.map(f=>[f.path,f]));
  return [...new Set([...a.keys(),...b.keys()])].sort().filter(p=>canonical(a.get(p)??null)!==canonical(b.get(p)??null));
}
function bindingValid(m){
  check(keys.every(k=>k==='acceptanceEpoch'?Number.isSafeInteger(m[k])&&m[k]>=0:typeof m[k]==='string'&&m[k].length>0&&m[k].length<=160)&&/^[a-f0-9]{40}$/.test(m.baseCommit),'Invalid snapshot binding');
}
// withSource must freeze an agent-unwritable writer checkout; resolveBase must attest
// complete Git base tree. Both are synthetic in tests; neither is a worker RPC.
export function protectedSnapshots({artifacts,resolveBase,withSource,checkpoint=async()=>{}}){
  check(typeof resolveBase==='function'&&typeof withSource==='function','Trusted source writer required');
  async function describeSnapshot(snapshotHash){
    check(hash(snapshotHash),'Invalid snapshot hash');
    const bytes=await artifacts.read(snapshotHash),m=JSON.parse(bytes.toString('utf8'));
    check(m.version===1&&m.kind==='protected-source'&&canonical(m)===bytes.toString('utf8'),'Invalid source manifest');bindingValid(m);filesValid(m.files);
    check(digest(canonical(m.files))===m.sourceHash,'Source hash mismatch');
    for(const f of m.files){const b=await artifacts.read(f.sha256);check(b.length===f.size,'Source blob size mismatch');}
    const base=await resolveBase(m);filesValid(base);
    const changedPaths=changes(base,m.files);check(changedPaths.length>0,'Empty source diff');
    return {...m,snapshotHash,changedPaths};
  }
  async function capture(binding){
    bindingValid(binding);
    return withSource(binding,async root=>{
      await realDirectory(root);const files=[],blobs=[];let total=0;
      async function walk(dir,prefix=''){
        for(const name of (await readdir(dir)).sort()){
          // Do not silently exclude .git or unknown file types from complete source.
          const path=sourcePath(prefix+name),absolute=join(dir,name),s=await lstat(absolute);
          check(!s.isSymbolicLink(),'Source symlink denied');
          if(s.isDirectory())await walk(absolute,path+'/');
          else{
            check(s.isFile()&&s.nlink===1,'Unsafe source type/hardlink');const bytes=await readSource(absolute);total+=bytes.length;
            check(files.length<2000&&total<=16*1024*1024,'Source tree too large');
            files.push({path,mode:'100644',sha256:digest(bytes),size:bytes.length});blobs.push(bytes);
          }
        }
      }
      await walk(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);filesValid(files);
      const base=await resolveBase(binding);filesValid(base);
      const diff=changes(base,files);check(diff.length>0,'Empty source diff');
      check(Array.isArray(binding.allowPaths)&&binding.allowPaths.length>0,'Source allowlist required');binding.allowPaths.forEach(sourcePath);
      check(diff.every(p=>binding.allowPaths.some(root=>p===root||p.startsWith(root+'/'))),'Source diff outside scope');
      const manifest={version:1,kind:'protected-source',...Object.fromEntries(keys.map(k=>[k,binding[k]])),sourceHash:digest(canonical(files)),files};
      for(const b of blobs)await artifacts.put(b);
      const snapshotHash=await artifacts.put(Buffer.from(canonical(manifest)));
      return describeSnapshot(snapshotHash);
    });
  }
  async function proposal(row,files){
    await checkpoint('validation');
    const previous=await describeSnapshot(row.snapshotHash);
    if(previous.revision!==row.revision||previous.acceptanceEpoch!==row.acceptanceEpoch)throw Error('Stale proposal source');
    // Full resulting tree, not a client-declared changed-path list.
    check(Array.isArray(files)&&files.length<=2000,'Invalid proposal files');
    const entries=files.map(f=>{
      check(f&&Object.keys(f).sort().join(',')==='base64,mode,path'&&f.mode==='100644'&&typeof f.base64==='string'&&f.base64.length<=3*1024*1024,'Invalid proposal entry/mode');sourcePath(f.path);
      const bytes=Buffer.from(f.base64,'base64');check(bytes.toString('base64')===f.base64,'Invalid proposal encoding');return {path:f.path,mode:f.mode,sha256:digest(bytes),size:bytes.length,bytes};
    }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const visible=entries.map(({bytes,...f})=>f);filesValid(visible);
    check(changes(previous.files,visible).length>0,'Empty proposal');
    const diff=changes(await resolveBase(row),visible);
    check(diff.every(p=>row.limits.sourcePaths.some(root=>p===root||p.startsWith(root+'/')))&&changes(previous.files,visible).every(p=>row.limits.sourcePaths.some(root=>p===root||p.startsWith(root+'/'))),'Proposal outside source scope');
    check(diff.every(p=>!p.split('/').some(c=>/^\.github$|^\.env(?:\.|$)|^(?:secret|credential)s?(?:\.|$)/i.test(c))),'Protected proposal path denied');
    const manifest={...Object.fromEntries(keys.map(k=>[k,previous[k]])),version:1,kind:'protected-source',revision:'candidate_'+row.operationID,acceptanceEpoch:row.acceptanceEpoch+1,authorSessionID:row.workerSessionID,authorPrincipalID:row.workerPrincipalID,sourceHash:digest(canonical(visible)),files:visible};
    for(const e of entries){await artifacts.put(e.bytes);await checkpoint('bytes');}
    await checkpoint('manifest');const snapshotHash=await artifacts.put(Buffer.from(canonical(manifest)));
    await describeSnapshot(snapshotHash);return {resultSnapshotHash:snapshotHash,resultRevision:manifest.revision};
  }
  return {capture,describeSnapshot,proposal};
}
