// Read-only room projection, NOT broker verification, task ledger or approval.
export function taskHandoff(task,messages=[],projectID=null){
  const binding=task.brokerBinding;
  const bound=!!binding&&['projectID','taskID','revision'].every(k=>typeof binding[k]==='string'&&binding[k].trim().length>0)&&Number.isSafeInteger(binding.acceptanceEpoch)&&binding.acceptanceEpoch>=0&&binding.taskID===task.id&&binding.projectID===projectID;
  const same=r=>bound&&['projectID','taskID','revision','acceptanceEpoch'].every(k=>r?.[k]===binding[k]);
  const evidence=same(task.buildEvidence)?task.buildEvidence:null;
  return {
    binding:bound?{projectID:binding.projectID,taskID:binding.taskID,revision:binding.revision,acceptanceEpoch:binding.acceptanceEpoch}:null,
    stage:'UNKNOWN', // ponytail: no authoritative stage field; add only with reviewed broker contract.
    plan:task.acceptanceCriteria??[],dependencies:task.dependencies??[],
    source:task.sourceReferences??[],files:[...(task.inputAttachments??[]),...(task.outputAttachments??[])],
    evidence,reviews:(task.reviews??[]).map(r=>({...r,currentBinding:same(r),distinctSessionLabels:!!r.authorSessionID&&!!r.reviewerSessionID&&r.authorSessionID!==r.reviewerSessionID,independent:false})),
    discussion:messages.filter(m=>m.taskID===task.id||messages.some(p=>p.taskID===task.id&&p.id===m.requestID)),
    authorization:false,verification:'NOT_VERIFIED',
  };
}
