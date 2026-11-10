// ADAPT: Beads ready_work/claim-next and Noriq claim freshness; see THIRD-PARTY-NOTICES.md.
export function taskReadiness(state,task){
  const plan=state.plans?.at(-1),reasons=[];
  if(!plan||task.planID!==plan.planID||task.planVersion!==plan.version)reasons.push('STALE_PLAN');
  if(!plan?.discussionClosed)reasons.push('DISCUSSION_OPEN');
  if(plan?.needsOwner)reasons.push('OWNER_REVIEW_REQUIRED');
  if(task.status!=='READY')reasons.push('NOT_READY');
  if(task.executionState==='outstanding')reasons.push('STOP_NOT_PROVEN');
  const blockedBy=task.dependencies.filter(id=>!state.tasks.some(t=>t.id===id&&t.planID===task.planID&&t.planVersion===task.planVersion&&t.status==='DONE'));
  if(blockedBy.length)reasons.push('DEPENDENCIES');
  return {ready:reasons.length===0,reasons,blockedBy};
}
export const readyTasks=state=>state.tasks.filter(t=>t.protocolVersion&&taskReadiness(state,t).ready);
