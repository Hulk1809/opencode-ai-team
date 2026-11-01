import {mkdir,realpath,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkWorktree,dataDirectory} from './persistence.mjs';
import {sourceRevision} from './evidence.mjs';
import {redact} from './safety.mjs';
const ACTIVATION_READY=false;
export async function assertBuildMount(directory){
  let count=0;
  async function visit(path){
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(++count>50000)throw Error('Build mount quá lớn để kiểm tra');
      if(entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile())||/^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|settings\.xml)$|\.(?:pem|key|p12|pfx)$/i.test(entry.name))throw Error('Build mount chứa symlink, special file hoặc credentials');
      if(entry.isDirectory())await visit(join(path,entry.name));
    }
  }
  await visit(directory);
}
export const BUILD_IMAGE='maven@sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237';
export function buildArgs(scope,goal){
  if(scope.image!==BUILD_IMAGE||!['test','verify'].includes(goal)||!scope.goals?.includes(goal))throw Error('Build goal/image ngoài scope');
  if(!Number.isSafeInteger(scope.uid)||scope.uid<=0||!Number.isSafeInteger(scope.gid)||scope.gid<0)throw Error('Build user không hợp lệ');
  if([scope.directory,scope.cache].some(p=>typeof p!=='string'||!p.startsWith('/')||/[\r\n,]/.test(p)))throw Error('Build mount không hợp lệ');
  return ['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',`--user=${scope.uid}:${scope.gid}`,'--cpus=2','--memory=1g','--pids-limit=256','--stop-timeout=5','--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
    '--mount',`type=bind,src=${scope.directory},dst=/workspace`,'--mount',`type=bind,src=${scope.cache},dst=/maven-cache`,'--workdir=/workspace','--env=MAVEN_OPTS=-Djansi.passthrough=true',
    '--entrypoint=/usr/share/maven/bin/mvn',BUILD_IMAGE,'-B','-o','-Dmaven.repo.local=/maven-cache',goal];
}
export async function approveBuild(ctx,room,directory,p){
  if(p.approved!==true||p.image!==BUILD_IMAGE||!['frontend','backend','devops','qa'].includes(p.role))throw Error('Owner phải duyệt image/role rõ ràng');
  // Fail closed until independent QA execution and uncertain container cleanup are accepted.
  if(!ACTIVATION_READY)throw Error('Build activation chưa mở: cần Owner approval manifest và hoàn thiện QA/timeout lifecycle');
  return room.exclusive(directory,async()=>{
    const fixtureRoot=await realpath(join(dataDirectory(),'fixtures'));
    if(!(await realpath(directory)).startsWith(fixtureRoot+'/'))throw Error('Build environment hiện chỉ cho persistent fixture, không production');
    const team=await room.read(directory),member=team.members[p.role];
    if(!member?.codingScope)throw Error('Duyệt coding scope trước build scope');
    if(team.messages.some(m=>m.to===p.role&&['waiting','queued','admitted','uncertain'].includes(m.status)))throw Error('Worker còn request pending');
    const tree=await checkWorktree(member.directory,directory),session=await ctx.session.get({sessionID:member.sessionID});
    if(await realpath(session.location.directory)!==tree.directory||member.codingScope.directory!==tree.directory)throw Error('Session/worktree sai scope');
    const cache=join(dataDirectory(),'build-cache',member.sessionID);
    if(p.directory!==tree.directory||p.cache!==cache)throw Error('Owner phải duyệt exact worktree/cache');
    const scope={id:randomUUID(),image:BUILD_IMAGE,directory:tree.directory,cache,goals:['test','verify'],uid:process.getuid(),gid:process.getgid(),approvedAt:new Date().toISOString(),approvedBy:'owner'};
    buildArgs(scope,'verify');
    await mkdir(cache,{recursive:true,mode:0o700});
    if(await realpath(cache)!==cache||(await lstat(cache)).uid!==scope.uid)throw Error('Cache identity không hợp lệ');
    member.buildEnvironment=scope;await room.write(directory,team);return scope;
  });
}
export async function executeBuild(scope,goal,taskID){
  if(!ACTIVATION_READY)throw Error('Build execution disabled pending activation acceptance');
  if(await realpath(scope.cache)!==scope.cache||await realpath(scope.directory)!==scope.directory)throw Error('Build mount identity thay đổi');
  buildArgs(scope,goal);
  await assertBuildMount(scope.directory);await assertBuildMount(scope.cache);
  const before=await sourceRevision(scope.directory),startedAt=new Date().toISOString();
  if(!Array.isArray(scope.approvedInputs)||!scope.approvedInputs.length)throw Error('Missing approved build input fingerprints');
  for(const approved of scope.approvedInputs){
    const current=before.sources.find(s=>s.path===approved.path);
    if(!current||current.sha256!==approved.sha256||current.mode!==approved.mode)throw Error('Build inputs changed; renewed Owner approval required');
  }
  const writable=new Set(scope.files??[]);
  if(!scope.approvedSources||before.sources.some(s=>!writable.has(s.path)&&!scope.approvedSources.some(a=>a.path===s.path&&a.sha256===s.sha256&&a.mode===s.mode))||scope.approvedSources.some(a=>!writable.has(a.path)&&!before.sources.some(s=>s.path===a.path&&s.sha256===a.sha256&&s.mode===a.mode)))throw Error('Unapproved source/build inputs changed');
  const {withBuildJobs}=await import('./build-jobs.mjs');
  const job=await withBuildJobs(join(dataDirectory(),'build-jobs'),async jobs=>{
    const pending=await jobs.load();
    for(const old of pending.jobs.filter(j=>['running','uncertain','timeout'].includes(j.state)&&!j.cleanedAt)){
      await jobs.reconcile(old.id);
    }
    const queued=await jobs.enqueue(scope,taskID,goal);
    return jobs.start(queued.id,scope);
  });
  const after=await sourceRevision(scope.directory);
  return {id:job.id,jobState:job.state,scopeID:scope.id,goal,command:`mvn -B -o -Dmaven.repo.local=/maven-cache ${goal}`,image:scope.image,startedAt,completedAt:new Date().toISOString(),beforeRevision:before.revision,...after,exitCode:job.exitCode??null,output:redact(job.output??''),status:job.state==='succeeded'&&job.cleanedAt&&before.revision===after.revision?'passed':'blocked'};
}
