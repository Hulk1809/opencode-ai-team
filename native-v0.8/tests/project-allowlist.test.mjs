import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {APPROVED_PROJECT,APPROVED_PROJECT_ROOT_COMMIT,approvedProject,registerOfficialCoordinator} from '../src/official-coordinator.mjs';
import {DEFAULT_MODELS} from '../src/model-routing.mjs';

test('unapproved restored projects and aliases have zero provisioning side effects',async()=>{
  const base=mkdtempSync(join(tmpdir(),'allowlist-'));
  try{
    const alias=join(base,'alias');symlinkSync(APPROVED_PROJECT,alias);
    for(const canonical of ['/tmp/opencode/v08-desktop-acceptance-project','/home/other/project',alias,APPROVED_PROJECT+'/',APPROVED_PROJECT+'/../v08-desktop-acceptance']){
      const ctx={location:{directory:canonical,project:{canonical,id:'other'}},options:{pilotStore:join(base,'store')}};
      assert.equal(approvedProject(ctx),false);
      const coordinator=await registerOfficialCoordinator(ctx);
      assert.equal(coordinator.read(),null);
      assert.equal(existsSync(ctx.options.pilotStore),false);
    }
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('approved canonical repo duplicate load, project switch and restart create one team only',async()=>{
  assert.notEqual(APPROVED_PROJECT_ROOT_COMMIT,'09fbd38e44fd9aa9fdcb318833f4ddbfa7485997');
  assert.equal(execFileSync('git',['-C',APPROVED_PROJECT,'rev-list','--max-parents=0','HEAD'],{encoding:'utf8'}).trim(),APPROVED_PROJECT_ROOT_COMMIT);
  assert.ok(approvedProject({location:{project:{canonical:APPROVED_PROJECT}}}));
  const base=mkdtempSync(join(tmpdir(),'allowlist-bootstrap-'));
  const repo=join(base,'repo');
  execFileSync('git',['clone','--no-hardlinks',APPROVED_PROJECT,repo],{stdio:'pipe'});
  let sessions=0,worktrees=0;
  const native=new Map();
  const ctx={location:{directory:repo,project:{canonical:repo,id:'approved'}},
    options:{pilotStore:join(base,'store'),pilotWake:false,nativeDispatch:false},
    tool:{transform:async()=>{}},
    model:{list:async()=>Object.values(DEFAULT_MODELS).map(m=>({...m,enabled:true,status:'active',variants:[{id:'medium'}]}))},
    session:{get:async({sessionID})=>native.get(sessionID),create:async input=>{sessions++;const s={id:`ses_test${sessions}`,projectID:'approved',agent:'build',location:input.location,model:input.model};native.set(s.id,s);return s;}},
    worktree:{create:async()=>{
      const directory=join(base,`worker${++worktrees}`);
      execFileSync('git',['-C',repo,'worktree','add','--detach',directory],{stdio:'pipe'});
      return {directory};
    }}};
  try{
    const [first]=await Promise.all([registerOfficialCoordinator(ctx),registerOfficialCoordinator(ctx)]);
    assert.equal(first.read(),null);assert.equal(sessions,0);assert.equal(worktrees,0);
    await first.bootstrap();
    assert.equal(first.read().status,'ready');assert.equal(sessions,4);assert.equal(worktrees,4);
    const other=await registerOfficialCoordinator({...ctx,location:{directory:'/other',project:{canonical:'/other',id:'other'}}});
    assert.equal(other.read(),null);
    const restarted=await registerOfficialCoordinator(ctx);
    assert.deepEqual(restarted.read(),first.read());assert.equal(sessions,4);assert.equal(worktrees,4);
    const workerLoad=await registerOfficialCoordinator({...ctx,location:{...ctx.location,directory:join(base,'worker1')}});
    assert.equal(workerLoad.read().members.length,4);assert.equal(sessions,4);
  }finally{rmSync(base,{recursive:true,force:true});}
});
