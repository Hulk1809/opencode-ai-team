import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';
import {spawnSync,execFileSync} from 'node:child_process';
import {existsSync,cpSync,unlinkSync} from 'node:fs';

test('process killed during pending write or after rename keeps complete state and requires inspected lock recovery',()=>{
  for(const phase of ['writeFileSync','renameSync']){
    const root=mkdtempSync('/tmp/opencode/pilot-kill-');
    const ctx={location:{project:{canonical:root}},options:{pilotStore:root}};
    const store=new OfficialCoordinator(ctx);
    store.mutate(()=>({state:{version:'old'}}));
    const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const original=fs.${phase};fs.${phase}=function(...args){const result=original(...args);process.kill(process.pid,'SIGKILL');return result};syncBuiltinESMExports();
      const {OfficialCoordinator}=await import(${JSON.stringify(new URL('../src/official-coordinator.mjs',import.meta.url).href)});
      new OfficialCoordinator(${JSON.stringify(ctx)}).mutate(()=>({state:{version:'new'}}));`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script]);
    assert.equal(child.signal,'SIGKILL');
    assert.equal(new OfficialCoordinator(ctx).read().version,phase==='renameSync'?'new':'old');
    assert.ok(existsSync(join(store.directory,'writer.lock')));
    assert.throws(()=>store.mutate(()=>({})),/BUSY_OR_RECOVERY_REQUIRED/);
    // Disposable child is confirmed dead; rehearse explicit operator backup/inspect/unlock.
    const backup=join(root,'inspected-backup');cpSync(store.directory,backup,{recursive:true});
    assert.deepEqual(JSON.parse(readFileSync(join(backup,'team.json'),'utf8')),store.read());
    unlinkSync(join(store.directory,'writer.lock'));
    new OfficialCoordinator(ctx).mutate(state=>({state:{...state,recovered:true}}));
    assert.equal(store.read().recovered,true);
    assert.ok(existsSync(join(backup,'writer.lock')));
  }
});

test('wake journals submitting before ambiguous admission; retry and peer send never resubmit',async()=>{
  const root=mkdtempSync('/tmp/opencode/pilot-wake-');
  execFileSync('git',['init','-b','feature-test',root],{stdio:'pipe'});
  const member={role:'worker-1',sessionID:'worker',agent:'build',directory:root,branch:'feature-test'};
  let calls=0,store;
  const ctx={location:{project:{canonical:root,id:'project'}},options:{pilotStore:root},session:{
    get:async()=>({id:'worker',projectID:'project',agent:'build',location:{directory:root}}),
    prompt:async()=>{calls++;assert.equal(store.read().messages[0].wake.status,'submitting');throw Error('ambiguous transport after admission');}
  }};
  store=new OfficialCoordinator(ctx);
  const assignment={id:'test-id',action:'assign',to:'worker-1',taskID:'task',text:'Build'};
  store.mutate(()=>({state:{projectID:'project',members:[member],messages:[assignment],tasks:[]}}));
  assert.equal((await store.wake(assignment)).wake.status,'uncertain');
  await new OfficialCoordinator(ctx).wake(assignment);
  await store.wake({action:'send'});
  assert.equal(calls,1);
  store.mutate(state=>{state.messages[0].wake.status='submitting';return {}});
  await store.wake(assignment);assert.equal(calls,1);
});

test('pilot store reopens; corrupt state and stale writer lock fail closed without deletion',()=>{
  const root=mkdtempSync('/tmp/opencode/pilot-recovery-');
  const ctx={location:{project:{canonical:root}},options:{pilotStore:root}};
  const store=new OfficialCoordinator(ctx);
  store.mutate(()=>({state:{messages:[{id:'preserved'}],tasks:[]}}));
  assert.equal(new OfficialCoordinator(ctx).read().messages[0].id,'preserved');
  const lock=join(store.directory,'writer.lock');writeFileSync(lock,'abandoned');
  assert.throws(()=>store.mutate(()=>({})),/BUSY_OR_RECOVERY_REQUIRED/);
  assert.equal(readFileSync(lock,'utf8'),'abandoned');
  writeFileSync(store.file,'{corrupt');assert.throws(()=>store.read(),SyntaxError);
});
