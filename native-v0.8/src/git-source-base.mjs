// Trusted repository path/ref only. Raw object reads: no checkout, hooks or filters.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {realDirectory,sourcePath} from './protected-snapshots.mjs';
import {digest} from './broker.mjs';
const exec=promisify(execFile);
export function gitSourceBase({gitDirectory,ref,commit,tree}){
  if(!/^refs\/heads\/[A-Za-z0-9_/-]+$/.test(ref)||![commit,tree].every(x=>/^[a-f0-9]{40}$/.test(x)))throw Error('Invalid trusted Git binding');
  async function git(args){
    const {stdout}=await exec('/usr/bin/git',['--no-replace-objects','--no-optional-locks',`--git-dir=${gitDirectory}`,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},encoding:'buffer',maxBuffer:20*1024*1024,timeout:10000});return stdout;
  }
  return async binding=>{
    await realDirectory(gitDirectory);
    for(const p of ['objects/info/alternates','objects/info/http-alternates','shallow']){try{await lstat(join(gitDirectory,p));throw Error('Unsupported Git object indirection');}catch(e){if(e.code!=='ENOENT')throw e;}}
    const current=(await git(['rev-parse','--verify',ref+'^{commit}'])).toString().trim();
    if(current!==commit||binding.baseCommit!==commit)throw Error('Git base/ref drift');
    if((await git(['rev-parse','--verify',commit+'^{tree}'])).toString().trim()!==tree)throw Error('Git tree drift');
    const files=[];
    for(const entry of (await git(['ls-tree','-rz','--full-tree',commit])).toString('utf8').split('\0').filter(Boolean)){
      const match=/^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if(!match)throw Error('Git file mode/submodule denied');const [,mode,oid,path]=match;sourcePath(path);
      const bytes=await git(['cat-file','blob',oid]);if(bytes.length>2*1024*1024)throw Error('Git blob too large');
      files.push({path,mode,sha256:digest(bytes),size:bytes.length});
      if(files.length>2000||files.reduce((n,f)=>n+f.size,0)>16*1024*1024)throw Error('Git tree too large');
    }
    if((await git(['rev-parse','--verify',ref+'^{commit}'])).toString().trim()!==commit)throw Error('Git ref changed during attestation');
    return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  };
}
