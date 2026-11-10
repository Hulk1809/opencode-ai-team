import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {DEFAULT_MODELS} from '../src/model-routing.mjs';
import {validateApproval,checkApprovedOperation,approvedPath,securityView,denyLiveAdmission} from '../src/peer-security.mjs';

test('scope records require exact Owner authority, binding, expiration, revocation and finite budget',()=>{
  const root=mkdtempSync('/tmp/opencode/security-scope-');
  try{
    const binding={projectID:'p',teamID:'t',canonicalRoot:root,generation:'g'};
    const record={...binding,id:'approval',ownerID:'owner',repository:root,branches:['peer-1'],operations:['read'],resources:[join(root,'file')],issuedAt:1,expiresAt:100,revokedAt:null,budget:{currency:'USD',maxCostMicros:100,maxPrompts:1,maxConcurrent:4,maxRetries:0}};
    const operation={action:'read',resource:join(root,'file'),repository:root,branch:'peer-1'};
    assert.equal(validateApproval(record,binding,50),record);
    assert.throws(()=>checkApprovedOperation(record,binding,operation,{now:50}),/AUTHORITY_NOT_PROVEN/);
    const trusted={now:50,ownerVerified:true,revocationVerified:true};
    assert.equal(checkApprovedOperation(record,binding,operation,trusted),true);
    for(const change of [{action:'shell'},{resource:join(root,'other')},{branch:'peer-2'},{repository:'/other'}])assert.throws(()=>checkApprovedOperation(record,binding,{...operation,...change},trusted),/FORBIDDEN/);
    assert.throws(()=>validateApproval(record,{...binding,projectID:'other'},50),/SCOPE/);
    assert.throws(()=>validateApproval(record,binding,100),/EXPIRED/);
    assert.throws(()=>validateApproval({...record,revokedAt:2},binding,50),/REVOKED/);
    for(const budget of [null,{...record.budget,maxConcurrent:5},{...record.budget,maxRetries:Infinity},{...record.budget,maxCostMicros:null}])assert.throws(()=>validateApproval({...record,budget},binding,50),/BUDGET/);
    assert.throws(()=>validateApproval({...record,resources:['*']},binding,50),/INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('path validation denies traversal, symlinks and cross-peer paths; no file opener claim',()=>{
  const root=mkdtempSync('/tmp/opencode/security-path-');
  try{
    mkdirSync(join(root,'peer-1'));mkdirSync(join(root,'peer-2'));writeFileSync(join(root,'peer-1','ok'),'ok');writeFileSync(join(root,'peer-2','other'),'other');
    symlinkSync(join(root,'peer-2'),join(root,'peer-1','link'));
    assert.equal(approvedPath(join(root,'peer-1'),'ok'),join(root,'peer-1','ok'));
    for(const path of ['../peer-2/other','/etc/passwd','a\\b','a/./b','file:secret'])assert.throws(()=>approvedPath(join(root,'peer-1'),path),/PATH/);
    assert.throws(()=>approvedPath(join(root,'peer-1'),'link/other'),/SYMLINK/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('unverified spending and forged peer security fields never admit live work or cleanup',()=>{
  const view=securityView({isolation:'read-only',security:{approved:true}});
  assert.equal(view.liveExecution,'BLOCKED');assert.equal(view.hardSpendingCap,'NOT_PROVEN');assert.equal(view.nonGitWrites,false);assert.equal(view.cleanupEnabled,false);assert.deepEqual(view.approvedOperations,[]);
  for(let i=0;i<2;i++)assert.throws(()=>denyLiveAdmission({ownerVerified:true,budget:0}),/PEER_LIVE_EXECUTION_BLOCKED/);
});
test('provisioning rejects main tree and unrelated repositories before branch/session writes',async()=>{
  const base=mkdtempSync('/tmp/opencode/security-git-');
  const repo=join(base,'repo'),other=join(base,'other');
  const git=(...args)=>execFileSync('git',args,{stdio:'pipe'});
  for(const path of [repo,other]){git('init','--initial-branch=main',path);git('-C',path,'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','init');}
  try{
    for(const [name,path,error] of [['main',repo,/ISOLATION/],['foreign',other,/REPOSITORY/]]){
      let sessions=0;
      const c=new OfficialCoordinator({location:{directory:repo,project:{canonical:repo,id:'p'}},options:{pilotStore:join(base,name)},model:{list:async()=>[{...DEFAULT_MODELS.worker,enabled:true,status:'active',variants:[{id:'medium'}]}]},worktree:{create:async()=>({directory:path})},session:{create:async()=>{sessions++;throw Error('UNEXPECTED');}}});
      await assert.rejects(c.bootstrap(),error);assert.equal(sessions,0);
      assert.equal(execFileSync('git',['-C',path,'branch','--show-current'],{encoding:'utf8'}).trim(),'main');
    }
  }finally{rmSync(base,{recursive:true,force:true});}
});
