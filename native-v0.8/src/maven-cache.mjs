import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
// Static preflight only. Sufficiency requires fixed offline Maven execution after approval.
export async function inspectMavenCache(directory){
  let files=0,bytes=0;const failures=[];
  async function visit(path){
    const s=await lstat(path);
    if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('Unsafe Maven cache entry');
    if(s.isFile()){if(++files>100000||(bytes+=s.size)>20*1024**3)throw Error('Cache inventory limit');if(path.endsWith('.lastUpdated'))failures.push(path.slice(directory.length+1));return;}
    for(const name of await readdir(path))await visit(join(path,name));
  }
  await visit(directory);return {directory,files,bytes,failedTransfers:failures,status:files?'unverified':'empty',offlineSufficiency:'requires-approved-maven-probe'};
}
