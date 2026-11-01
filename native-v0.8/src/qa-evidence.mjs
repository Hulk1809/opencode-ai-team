// Broker verifies trusted adapter evidence, not signed worker PASS assertions.
export async function verifySourceEvidence({row,evidence,snapshot,verifyAdapter}){
  if(!snapshot||snapshot.authorSessionID===row.workerSessionID||snapshot.authorPrincipalID===row.workerPrincipalID)throw Error('Independent source QA required');
  if(!evidence||evidence.snapshotHash!==row.snapshotHash||evidence.sourceHash!==snapshot.sourceHash||evidence.revision!==row.revision||evidence.acceptanceEpoch!==row.acceptanceEpoch||evidence.baseCommit!==row.baseCommit||evidence.operationID!==row.operationID||evidence.attemptID!==row.attemptID||evidence.qaPrincipalID!==row.workerPrincipalID)throw Error('Stale/foreign source QA evidence');
  if(!Array.isArray(evidence.checks)||!evidence.checks.length||!evidence.checks.every(c=>typeof c.id==='string'&&c.id.length>0&&c.status==='pass'&&/^[a-f0-9]{64}$/.test(c.outputHash)))throw Error('Invalid source QA checks');
  if(await verifyAdapter(row,evidence,'source-qa')!==true)throw Error('Source QA adapter unverified');
  return true;
}
