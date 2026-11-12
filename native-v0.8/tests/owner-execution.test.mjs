import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {startHostOwnerBridge} from '../src/host-owner-bridge.mjs';
import {sessionActivity} from '../src/peer-native.mjs';
import {reportBody,writeReport} from '../src/pilot-reports.mjs';

test('signed Owner policy grants scoped start once; tampering, replay, revocation deny',async t=>{
  const dir=mkdtempSync('/tmp/opencode/execution-test-'),previous=process.env.OPENCODE_OWNER_AUTHORITY_DIR;
  const worker=mkdtempSync('/tmp/opencode/execution-worker-');t.after(()=>rmSync(worker,{recursive:true,force:true}));
  process.env.OPENCODE_OWNER_AUTHORITY_DIR=dir;
  t.after(()=>{if(previous===undefined)delete process.env.OPENCODE_OWNER_AUTHORITY_DIR;else process.env.OPENCODE_OWNER_AUTHORITY_DIR=previous;rmSync(dir,{recursive:true,force:true});});
  const bridge=await startHostOwnerBridge(dir,{getWindows:()=>[{id:7,isDestroyed:()=>false}],confirmDialog:async()=>true});
  assert.equal(await startHostOwnerBridge(dir),bridge);
  t.after(()=>bridge.close());
  const model={providerID:'fixture',id:'controlled'},plan={planID:'p',version:1,digest:'digest',ownerDecision:'approve',discussionClosed:true};
  const member={id:'peer-1',sessionID:'s1',branch:'peer-1',directory:worker+'/worktree',modelDefault:model};
  const state={mode:'peer',status:'ready',isolation:'git-worktree',canonicalRoot:dir,projectID:'project',teamID:'team',plans:[plan],members:[member],tasks:[]};
  const c=Object.create(OfficialCoordinator.prototype);c.root=dir;c.ctx={location:{project:{id:'project'}}};c.mutate=fn=>fn(state).value;
  const policy=await bridge.signExecutionPolicy({window:7},{projectID:'project',teamID:'team',policy:{planID:'p',planVersion:1,digest:'digest',maxActive:4,maxAttemptsPerTask:5,maxCalls:40,timeoutMs:900000,models:[model],capabilityID:'unique'}});
  const input={operation:'execution',requestID:'grant',planID:'p',planVersion:1,digest:'digest',policy};
  await assert.rejects(c.ownerPlan({...input,policy:{...policy,maxCalls:41}}),/SIGNATURE_INVALID/);
  const receipt=await c.ownerPlan(input);assert.equal(state.executionPolicy.usedCalls,0);
  assert.deepEqual(await c.ownerPlan(input),receipt);
  const task={id:'task',protocolVersion:1,planID:'p',planVersion:1,taskVersion:1,ownershipGeneration:1,workRevision:1,status:'CLAIMED',assignee:'peer-1',reviewer:'peer-2',dependencies:[],files:['check.test.js'],requiredCapabilities:[],acceptanceCriteria:['test'],requiredChecks:['node --test'],executionState:'not-started',lease:{id:'lease',expiresAt:Date.now()+60000}};
  state.tasks.push(task);c.caller=async()=>member;c.read=()=>state;c.dispatchMessages=async()=>{};
  const start={requestID:'start',taskID:'task',taskVersion:1,ownershipGeneration:1,leaseID:'lease',planID:'p',planVersion:1,projectID:'project',teamID:'team',canonicalRoot:dir};
  await c.protocol('start',start,{});
  assert.equal(task.status,'RUNNING');assert.equal(state.executionPolicy.usedCalls,1);assert.equal(state.executions[0].scope,'worktree');
  assert.equal(task.lease.expiresAt,state.executions[0].deadline);
  await c.protocol('start',start,{});assert.equal(state.executionPolicy.usedCalls,1);assert.equal(state.executions.length,1);
  const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],{cwd:dir,encoding:'utf8',stdio:'pipe'}).trim();
  git('init');git('commit','--allow-empty','-m','fixture');git('worktree','add','-b','peer-1',member.directory);
  writeFileSync(dir+'/.git/info/exclude','owner-authority.*\nstore/\n');
  c.directory=dir+'/store';mkdirSync(c.directory);c.caller=async()=>member;
  await assert.rejects(c.worktreeExec({mode:'apply',taskID:'task',files:[{path:'check.test.js',content:'must not write'},{path:'outside.js',content:'no'}]},{}),/OUT_OF_SCOPE/);
  assert.throws(()=>readFileSync(member.directory+'/check.test.js'),/ENOENT/);
  const applied=await c.worktreeExec({mode:'apply',taskID:'task',files:[{path:'check.test.js',content:"const assert=require('node:assert/strict');assert.equal(2+2,4);"}]},{});
  assert.equal(applied.sandbox,'bwrap-v1');assert.match(applied.sourceCommit,/^[a-f0-9]{40}$/);
  assert.equal(applied.commands[0].command,'node --test');assert.equal(applied.commands[0].exitCode,0);
  assert.equal(task.executionState,'stopped');assert.equal(state.executions[0].stopReceipt.sourceCommit,applied.sourceCommit);
  assert.match(readFileSync(member.directory+'/check.test.js','utf8'),/2\+2/);
  const reviewer={id:'peer-2',role:'peer-2',sessionID:'s2',modelDefault:model};member.role='peer-1';state.members.push(reviewer);
  task.status='REVIEW';task.review={memberID:'peer-2',workRevision:1,ownershipGeneration:1};
  for(const owner of [member,reviewer]){
    const r=reportBody({taskID:task.id,text:applied.sourceCommit,files:task.files,commands:applied.commands,status:'completed',diff:applied.diff,remaining:''},state,owner);
    writeReport(c.directory,r);state.artifacts??=[];state.artifacts.push(r);
    if(owner===member)task.submission=r.id;else task.review.reportID=r.id;
  }
  const integrate={...start,requestID:'integration',taskVersion:task.taskVersion};delete integrate.leaseID;
  c.caller=async()=>reviewer;
  await assert.rejects(c.protocol('integrate',integrate,{}),/POLICY_REQUIRED/);
  const integrationPolicy=await bridge.signExecutionPolicy({window:7},{projectID:'project',teamID:'team',policy:{...policy,capabilityID:'worktree-integration-v1:integration'}});
  await assert.rejects(c.ownerPlan({...input,requestID:'tampered',policy:{...policy,capabilityID:'worktree-integration-v1:forged'}}),/SIGNATURE_INVALID/);
  await c.ownerPlan({...input,requestID:'integration-grant',policy:integrationPolicy});
  assert.equal(state.executionPolicy.usedCalls,1);
  c.caller=async()=>member;
  await assert.rejects(c.protocol('integrate',integrate,{}),/INDEPENDENT_REVIEW_REQUIRED/);
  c.caller=async()=>reviewer;
  writeFileSync(dir+'/user-work.txt','keep');
  await assert.rejects(c.protocol('integrate',integrate,{}),/CANONICAL_DIRTY/);
  assert.equal(git('rev-parse','HEAD'),applied.baseCommit);
  assert.equal(readFileSync(dir+'/user-work.txt','utf8'),'keep');
  rmSync(dir+'/user-work.txt');
  assert.equal((await c.protocol('integrate',integrate,{})).status,'INTEGRATED');
  assert.equal(git('rev-parse','HEAD'),state.integrations[0].resultCommit);
  assert.equal(state.integrations[0].canonicalCommit,state.integrations[0].resultCommit);
  assert.match(readFileSync(dir+'/check.test.js','utf8'),/2\+2/);
  assert.equal((await c.protocol('integrate',integrate,{})).status,'INTEGRATED');
  assert.equal(state.integrations.length,1);
  c.caller=async()=>member;
  task.status='CLAIMED';task.executionState='not-started';task.lease.expiresAt=Date.now()+60000;
  await c.protocol('start',{...start,requestID:'failed-check-start',taskVersion:task.taskVersion},{});
  await assert.rejects(c.worktreeExec({mode:'apply',taskID:task.id,files:[{path:'check.test.js',content:'throw Error("check failed")'}]},{}),/CHECK_FAILED/);
  assert.equal(task.executionState,'stopped');
  assert.equal(state.executions.at(-1).stopReceipt.outcome,'failed');
  assert.equal(state.executions.at(-1).stopReceipt.sourceCommit,undefined);
  await assert.rejects(c.protocol('submit',{...start,requestID:'failed-submit',taskVersion:task.taskVersion,reportID:task.submission},{}),/FAILED_ATTEMPT_REQUIRES_RECONCILE/);
  assert.match(readFileSync(member.directory+'/check.test.js','utf8'),/check failed/);
  assert.equal(git('rev-parse','HEAD'),state.integrations[0].resultCommit);
  // Policy refresh with updated member model while task execution is outstanding preserves usedCalls; expired worktree attempt reconciles safely.
  const nextModel={providerID:'fixture',id:'upgraded'};member.modelDefault=nextModel;
  task.executionState='outstanding';state.executions.at(-1).state='admitted-by-adapter';delete state.executions.at(-1).stopReceipt;state.executions.at(-1).deadline=Date.now()-1;task.lease.expiresAt=Date.now()-1;
  const refreshedModelPolicy=await bridge.signExecutionPolicy({window:7},{projectID:'project',teamID:'team',policy:{...integrationPolicy,models:[nextModel,model],capabilityID:'worktree-integration-v1:model-refresh'}});
  await c.ownerPlan({...input,requestID:'model-refresh-grant',policy:refreshedModelPolicy});
  assert.equal(state.executionPolicy.usedCalls,2);
  const reconciled=await c.protocol('reconcile',{requestID:'reconcile-expired',taskID:task.id,taskVersion:task.taskVersion,ownershipGeneration:task.ownershipGeneration,planID:'p',planVersion:1,projectID:'project',teamID:'team',canonicalRoot:dir},{});
  assert.equal(reconciled.status,'READY');assert.equal(state.executions.at(-1).stopReceipt.receiptID,`worktree-expired:${state.executions.at(-1).id}`);
  // Verify-only task (files: []) runs requiredChecks on canonical HEAD and completes review/integrate/done without modifying files.
  const verifyTask={id:'task-verify',text:'verify',protocolVersion:1,planID:'p',planVersion:1,taskVersion:1,ownershipGeneration:1,workRevision:1,status:'CLAIMED',assignee:'peer-1',reviewer:'peer-2',dependencies:[],files:[],requiredCapabilities:[],acceptanceCriteria:['test'],requiredChecks:['node --test'],executionState:'not-started',lease:{id:'lease-v',expiresAt:Date.now()+60000}};
  state.tasks.push(verifyTask);git('-C',member.directory,'checkout','--','check.test.js');
  await c.protocol('start',{...start,requestID:'verify-start',taskID:'task-verify',leaseID:'lease-v'},{});
  const verifiedApply=await c.worktreeExec({mode:'apply',taskID:'task-verify',files:[]},{});
  assert.equal(verifiedApply.sourceCommit,verifiedApply.baseCommit);assert.deepEqual(verifiedApply.files,[]);
  verifyTask.status='REVIEW';verifyTask.review={memberID:'peer-2',workRevision:1,ownershipGeneration:1};
  for(const owner of [member,reviewer]){
    const r=reportBody({taskID:verifyTask.id,text:verifiedApply.sourceCommit,files:[],commands:verifiedApply.commands,status:'completed',diff:verifiedApply.diff,remaining:''},state,owner);
    writeReport(c.directory,r);state.artifacts.push(r);
    if(owner===member)verifyTask.submission=r.id;else verifyTask.review.reportID=r.id;
  }
  c.caller=async()=>reviewer;
  assert.equal((await c.protocol('integrate',{...integrate,requestID:'verify-integrate',taskID:'task-verify',taskVersion:verifyTask.taskVersion},{})).status,'INTEGRATED');
  assert.equal((await c.protocol('done',{...integrate,requestID:'verify-done',taskID:'task-verify',taskVersion:verifyTask.taskVersion},{})).status,'DONE');
  state.executionPolicy.usedCalls=4;
  await assert.rejects(c.ownerPlan({...input,requestID:'replay'}),/REPLAY/);
  assert.equal(state.executionPolicy.usedCalls,4);
  await c.ownerPlan({operation:'execution',requestID:'revoke',revoke:true,planID:'p',planVersion:1,digest:'digest'});
  assert.ok(state.executionPolicy.revokedAt);
  task.status='CLAIMED';task.executionState='not-started';task.assignee='peer-1';task.lease={id:'lease',expiresAt:Date.now()+60000};
  c.caller=async()=>member;
  await assert.rejects(c.protocol('start',{...start,requestID:'revoked-start',taskVersion:task.taskVersion,ownershipGeneration:task.ownershipGeneration},{}),/REVOKED/);
  assert.equal(state.executionAuthorizations.length,4);
});

test('server API without active() treats unknown context as busy; terminal idle as idle',async()=>{
  for(const [rows,busy] of [[[],true],[[{type:'user'}],true],[[{type:'idle',outcome:'succeeded'}],false]]){
    assert.equal((await sessionActivity({session:{context:async()=>rows}},'s')).s,busy);
  }
});
