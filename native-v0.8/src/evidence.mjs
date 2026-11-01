import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
const run=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// ponytail: snapshot whole non-ignored Git input, not only approved files; large repos need a bounded manifest store.
export async function sourceRevision(directory){
  const git=async args=>(await run('git',['-C',directory,...args],{timeout:10000,maxBuffer:8*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  const baseSHA=(await git(['rev-parse','HEAD'])).trim();
  const paths=[...new Set((await git(['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0').filter(Boolean))].sort();
  const sources=[];
  for(const path of paths){
    try{
      const stat=await lstat(join(directory,path));
      if(!stat.isFile())throw Error('Source evidence requires regular files');
      sources.push({path,sha256:hash(await readFile(join(directory,path))),mode:stat.mode&0o777});
    }catch(error){if(error.code!=='ENOENT')throw error;sources.push({path,deleted:true});}
  }
  const diff=await git(['diff','HEAD','--no-ext-diff','--no-textconv','--binary']);
  return {baseSHA,sources,diff,revision:hash(JSON.stringify({baseSHA,sources,diff}))};
}

export function currentEvidence(evidence,revision){
  return Boolean(evidence&&!evidence.stale&&evidence.revision===revision&&evidence.beforeRevision===revision&&evidence.exitCode===0);
}

export function invalidateEvidence(task,revision){
  const epoch=task.acceptanceEpoch??0;
  for(const evidence of [task.buildEvidence,task.qaEvidence,...(task.reviews??[])]){
    if(evidence&&(evidence.revision!==revision||evidence.acceptanceEpoch!==epoch)){
      evidence.stale=true;evidence.staleReason=evidence.revision!==revision?'source_changed':'task_reopened';
    }
  }
}

export function assertCompletionEvidence(task,revision,role){
  invalidateEvidence(task,revision);
  const build=task.buildEvidence,qa=task.qaEvidence,epoch=task.acceptanceEpoch??0;
  if(!currentEvidence(build,revision)||build.taskID!==task.id||build.acceptanceEpoch!==epoch||build.status!=='passed')throw Error('DONE bị chặn: build evidence thiếu hoặc stale');
  if(!currentEvidence(qa,revision)||qa.taskID!==task.id||qa.acceptanceEpoch!==epoch||qa.buildID!==build.id||qa.sessionID===build.sessionID||qa.status!=='passed')throw Error('DONE bị chặn: thiếu QA execution độc lập đúng revision/build');
  const reviewers=task.assignee==='qa'?['owner','admin']:['qa'];
  if(!task.reviews?.some(r=>!r.stale&&reviewers.includes(r.from)&&r.revision===revision&&r.buildID===build.id&&r.qaID===qa.id&&r.acceptanceEpoch===epoch))throw Error('DONE bị chặn: thiếu independent review đúng revision/build');
  if(!task.outputAttachments?.length)throw Error('DONE bị chặn: thiếu artifact');
  if(!['owner','admin'].includes(role))throw Error('DONE cần Owner/Admin nghiệm thu sau independent review');
}
