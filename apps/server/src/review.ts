import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Team } from './team.ts';
const exec=promisify(execFile);

export async function reviewSnapshot(team:Team,taskID:string) {
  const task=team.store.get('tasks',taskID);
  const agent=team.store.all('agents').find(a=>a.projectID===task.projectID&&a.role===task.assignee);
  if(!agent?.directory)throw new Error('Task chưa có worktree');
  const git=async(args:string[])=>(await exec('git',['-C',agent.directory,...args],{maxBuffer:8*1024*1024})).stdout;
  const untracked=(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).filter(p=>p!=='.opencode/opencode.jsonc');
  if(untracked.length)throw new Error(`Cần stage thủ công file mới trước review (không stage credential): ${untracked.join(', ')}`);
  const patch=await git(['diff','--binary','HEAD','--','.',':(exclude).opencode/opencode.jsonc']);
  const base= (await git(['rev-parse','HEAD'])).trim();
  if(!patch.trim())throw new Error('Không có diff để review');
  const digest=createHash('sha256').update(base+'\0'+patch).digest('hex');
  return {taskID,directory:agent.directory,base,digest,patch};
}

export async function prepareReview(team:Team,taskID:string) {
  const snapshot=await reviewSnapshot(team,taskID);
  team.store.patch('tasks',taskID,{review:{...snapshot,createdAt:new Date().toISOString()},approved:false,verification:null,integratedAt:null});
  team.changed();return snapshot;
}

export async function approveReview(team:Team,taskID:string) {
  const task=team.store.get('tasks',taskID);
  if(task.status!=='Done'||!task.evidence||!task.verification)throw new Error('Cần QA Done với bằng chứng tool test thực tế');
  const snapshot=await reviewSnapshot(team,taskID);
  if(!task.review||snapshot.digest!==task.review.digest||snapshot.digest!==task.verification.digest)throw new Error('Code thay đổi hoặc chưa tạo snapshot; cần QA xác minh lại');
  const result=team.store.patch('tasks',taskID,{approved:true,approvedDigest:snapshot.digest,approvedAt:new Date().toISOString()});
  team.log('review.approved',{taskID,digest:snapshot.digest},task.projectID);return result;
}
