import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {mkdir,open,readFile,realpath,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export const dataDirectory=()=>join(isAbsolute(process.env.XDG_DATA_HOME??'')?process.env.XDG_DATA_HOME:join(homedir(),'.local/share'),'opencode','ai-team');
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function checkWorktree(directory,repository) {
  if(!isAbsolute(directory??'')||!isAbsolute(repository??''))throw Error('Worktree/repository cần đường dẫn tuyệt đối');
  const tree=await realpath(directory),source=await realpath(repository);
  if(!(await lstat(join(tree,'.git'))).isFile())throw Error('Coding cần linked Git worktree, không dùng checkout chung');
  const git=async(cwd,args)=>(await run('git',['-C',cwd,...args],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
  if(await realpath(await git(tree,['rev-parse','--show-toplevel']))!==tree)throw Error('Sai worktree root');
  const common=await realpath(await git(tree,['rev-parse','--path-format=absolute','--git-common-dir']));
  if(common!==await realpath(await git(source,['rev-parse','--path-format=absolute','--git-common-dir'])))throw Error('Worktree thuộc repository khác');
  const inventory=await git(source,['worktree','list','--porcelain','-z']);
  if(!inventory.split('\0').includes(`worktree ${tree}`))throw Error('Worktree không có trong Git inventory');
  return {directory:tree,commonDirectory:common,head:await git(tree,['rev-parse','--verify','HEAD'])};
}

// ponytail: application backup only; sessions/Git/uncommitted sources need separate server/Git backup.
export class TeamPersistence {
  constructor(room,root=dataDirectory()){this.room=room;this.root=root;}
  async backup(directory) {
    return this.room.exclusive(directory,async()=>{
      const team=await this.room.read(directory);if(!team)throw Error('Room không tồn tại');
      const artifacts=[];
      for(const meta of team.files??[]){
        const file=await this.room.ctx.storage.get(`files/${encodeURIComponent(directory)}/${meta.id}`);
        if(!file||hash(Buffer.from(file.base64,'base64'))!==file.checksum)throw Error('Artifact thiếu hoặc checksum sai');
        artifacts.push(file);
      }
      const payload=JSON.stringify({version:1,directory,createdAt:new Date().toISOString(),team,artifacts});
      const id=randomUUID(),folder=join(this.root,'backups');await mkdir(folder,{recursive:true,mode:0o700});
      const path=join(folder,`${id}.json`),file=await open(path,'wx',0o600);
      try{await file.writeFile(JSON.stringify({sha256:hash(payload),payload}));await file.sync();}finally{await file.close();}
      const parent=await open(folder,'r');try{await parent.sync();}finally{await parent.close();}
      return {id,path,sha256:hash(payload),artifacts:artifacts.length};
    });
  }
  async restore(directory,id) {
    if(!/^[0-9a-f-]{36}$/.test(id??''))throw Error('Backup ID không hợp lệ');
    const envelope=JSON.parse(await readFile(join(this.root,'backups',`${id}.json`),'utf8'));
    if(typeof envelope.payload!=='string'||hash(envelope.payload)!==envelope.sha256)throw Error('Backup checksum sai');
    const data=JSON.parse(envelope.payload);
    if(data.version!==1||data.directory!==directory||data.team?.directory!==directory||!Array.isArray(data.team.messages)||!Array.isArray(data.artifacts)||!data.team.members)throw Error('Backup schema/directory sai');
    const ids=new Set();
    for(const f of data.artifacts){
      if(!/^[0-9a-f-]{36}$/.test(f.id)||ids.has(f.id)||!Array.isArray(f.acl)||typeof f.base64!=='string'||hash(Buffer.from(f.base64,'base64'))!==f.checksum)throw Error('Artifact backup không hợp lệ');
      ids.add(f.id);
    }
    if((data.team.files??[]).length!==ids.size||(data.team.files??[]).some(f=>!ids.has(f.id)))throw Error('Artifact manifest sai');
    return this.room.exclusive(directory,async()=>{
      if(await this.room.read(directory))throw Error('Room đã tồn tại; không ghi đè hoặc rollback queue');
      for(const f of data.artifacts){const old=await this.room.ctx.storage.get(`files/${encodeURIComponent(directory)}/${f.id}`);if(old&&JSON.stringify(old)!==JSON.stringify(f))throw Error('Artifact conflict; không ghi đè');}
      // Publish room last. Interrupted restores leave only identical orphan files, safe to retry.
      for(const f of data.artifacts)await this.room.ctx.storage.set(`files/${encodeURIComponent(directory)}/${f.id}`,f);
      data.team.recovery={paused:true,backupID:id,at:new Date().toISOString(),reason:'Verify sessions, Git worktrees and durable queue before explicit resume'};
      await this.room.write(directory,data.team);
      return {restored:true,paused:true,backupID:id};
    });
  }
}
