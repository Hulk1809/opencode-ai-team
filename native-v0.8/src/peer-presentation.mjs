export const taskState=t=>String(t.status??'UNKNOWN').toUpperCase();
export const taskDone=t=>['DONE'].includes(taskState(t));
export const taskActive=t=>!['DONE','CANCELLED','FAILED'].includes(taskState(t));
export function memberTasks(team,member){return (team.tasks??[]).filter(t=>t.assignee===(member.id??member.role)||t.assignee===member.role);}
export function taskProgress(t){
  // ponytail: lifecycle milestones, not measured work; add measured progress only from trusted execution evidence.
  return ({DRAFT:0,READY:0,CLAIMED:1,RUNNING:2,WORKING:2,SUBMITTED:3,REVIEW:4,INTEGRATED:5,DONE:6,REWORK:1})[taskState(t)]??0;
}
export function uniqueMessages(messages){const seen=new Set();return messages.filter(m=>typeof m.id==='string'&&!seen.has(m.id)&&seen.add(m.id));}
export function routingAdmissionBlocked(team,member){
  if(team.mode==='peer'&&team.runtime?.protocolVersion!==1)return true;
  if(!Array.isArray(team.tasks)||!Array.isArray(team.messages))return true;
  return team.tasks.some(t=>memberTasks({tasks:[t]},member).length&&(t.executionState==='outstanding'||['CLAIMED','RUNNING','REWORK','BLOCKED'].includes(taskState(t))))||
    team.messages.some(m=>['team',member.id,member.role].includes(m.to)&&['submitting','admitted','uncertain'].includes(m.wake?.status));
}
// ponytail: safe Markdown subset, no HTML, images, links, or embedded diagrams; extend with vetted host sanitizer contract.
export function markdownBlocks(text){
  const lines=String(text).replace(/\r\n?/g,'\n').split('\n'),blocks=[];let code=null;
  for(const line of lines){
    if(/^\s*```/.test(line)){if(code!==null){blocks.push({kind:'code',text:code.join('\n')});code=null;}else code=[];continue;}
    if(code!==null){code.push(line);continue;}
    const heading=/^(#{1,6})\s+(.*)$/.exec(line),item=/^\s*(?:[-*+] |\d+\. )(.*)$/.exec(line);
    blocks.push(heading?{kind:'heading',level:heading[1].length,text:heading[2]}:item?{kind:'item',text:item[1]}:line.startsWith('> ')?{kind:'quote',text:line.slice(2)}:{kind:'text',text:line});
  }
  if(code!==null)blocks.push({kind:'code',text:code.join('\n')});return blocks;
}
