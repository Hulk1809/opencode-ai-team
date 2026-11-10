import {constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export function reportBody(input,state,member){
  if(!state.teamID||state.projectID==null)throw Error('REPORT_TEAM_ID_REQUIRED');
  const task=state.tasks.find(t=>t.id===input.taskID&&(state.mode==='peer'||member.role==='admin'||t.assignee===member.role));
  if(!task)throw Error('REPORT_TASK_FORBIDDEN');
  if(typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>200000)throw Error('REPORT_CONTENT_INVALID');
  if(!Array.isArray(input.files)||input.files.some(p=>typeof p!=='string'||!p||p.startsWith('/')||p.includes('\\')||p.split('/').some(x=>x==='..'||x==='.')||/[\x00-\x1f]/.test(p)))throw Error('REPORT_FILES_INVALID');
  if(!Array.isArray(input.commands)||!input.commands.length||input.commands.some(c=>typeof c?.command!=='string'||!c.command.trim()||!Number.isInteger(c.exitCode)||typeof c.output!=='string'))throw Error('REPORT_COMMAND_EVIDENCE_REQUIRED');
  if(!['completed','blocked'].includes(input.status)||typeof input.diff!=='string'||!input.diff.trim()||typeof input.remaining!=='string')throw Error('REPORT_EVIDENCE_REQUIRED');
  if(input.status==='completed'&&input.commands.some(c=>c.exitCode!==0))throw Error('REPORT_FAILED_CHECKS');
  const content=`# ${member.role} task report\n\nProject: ${state.projectID}\nTeam: ${state.teamID}\nTask: ${task.id}\nStatus: ${input.status}\n\n## Công việc được giao\n${task.text}\n\n## Files đã thay đổi\n${input.files.map(p=>`- ${p}`).join('\n')||'Không có'}\n\n## Cách triển khai\n${input.text}\n\n## Commands/tests và exit codes\n${input.commands.map(c=>`${c.command}\nExit code: ${c.exitCode}\n\n${c.output}`).join('\n\n')}\n\n## Git diff summary\n${input.diff}\n\n## Lỗi còn tồn tại\n${input.remaining||'Không được báo cáo'}\n\nEvidence do agent cung cấp; chưa phải xác minh độc lập của Admin.\n`;
  if(Buffer.byteLength(content)>256000)throw Error('REPORT_TOO_LARGE');
  const versionedContent=task.protocolVersion?`${content}\nPlan version: ${task.planVersion}\nOwnership generation: ${task.ownershipGeneration}\nWork revision: ${task.workRevision}\n`:content;
  const id='report_'+createHash('sha256').update(JSON.stringify([state.projectID,state.teamID,task.id,member.sessionID,versionedContent])).digest('hex');
  return {id,projectID:state.projectID,teamID:state.teamID,taskID:task.id,owner:member.role,sessionID:member.sessionID,name:`${member.role}-task-${id.slice(7,19)}.md`,storageRef:`${id}.md`,content:versionedContent,status:input.status,...(task.protocolVersion?{planVersion:task.planVersion,ownershipGeneration:task.ownershipGeneration,workRevision:task.workRevision,checks:input.commands.map(c=>({command:c.command,exitCode:c.exitCode}))}:{})};
}
function reportDirectory(directory){
  const path=join(directory,'reports');mkdirSync(path,{recursive:true,mode:0o700});
  if(realpathSync(path)!==path)throw Error('REPORT_STORAGE_UNSAFE');
  return path;
}
export function writeReport(directory,report){
  if(!/^report_[a-f0-9]{64}$/.test(report.id))throw Error('REPORT_ID_INVALID');
  const path=join(reportDirectory(directory),`${report.id}.md`);
  let fd;
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,report.content);fsyncSync(fd);}catch(e){
    if(e.code!=='EEXIST')throw e;
    if(readReportFile(path)!==report.content)throw Error('REPORT_STORAGE_CONFLICT');
  }finally{if(fd!==undefined)closeSync(fd);}
  const dir=openSync(join(directory,'reports'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
function readReportFile(path){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
export function readReport(directory,state,projectID,id){
  if(typeof id!=='string'||!/^report_[a-f0-9]{64}$/.test(id)||state?.projectID!==projectID)throw Error('REPORT_FORBIDDEN');
  const report=state.artifacts?.find(a=>a.id===id&&a.projectID===projectID&&a.teamID===state.teamID);
  if(!report||!state.tasks.some(t=>t.id===report.taskID)||!state.members.some(m=>m.sessionID===report.sessionID&&m.role===report.owner))throw Error('REPORT_FORBIDDEN');
  const reports=join(directory,'reports');if(realpathSync(reports)!==reports)throw Error('REPORT_STORAGE_UNSAFE');
  const content=readReportFile(join(reports,`${id}.md`));
  if('report_'+createHash('sha256').update(JSON.stringify([report.projectID,report.teamID,report.taskID,report.sessionID,content])).digest('hex')!==id)throw Error('REPORT_INTEGRITY_MISMATCH');
  return {...report,content};
}
