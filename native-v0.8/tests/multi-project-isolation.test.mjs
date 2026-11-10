import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {OfficialCoordinator,registerOfficialCoordinator,validGitProject,projectIdentity} from '../src/official-coordinator.mjs';
import {DEFAULT_MODELS} from '../src/model-routing.mjs';

function createGitRepo(dir){
  mkdirSync(dir,{recursive:true});
  execFileSync('git',['init','--initial-branch=main',dir],{stdio:'pipe'});
  execFileSync('git',['-C',dir,'config','user.email','test@example.com'],{stdio:'pipe'});
  execFileSync('git',['-C',dir,'config','user.name','Tester'],{stdio:'pipe'});
  execFileSync('git',['-C',dir,'commit','--allow-empty','-m','init'],{stdio:'pipe'});
  return dir;
}

test('dynamic multi-project isolation, explicit creation, reuse and coordinator chat flows',async()=>{
  const base=mkdtempSync(join(tmpdir(),'multi-proj-'));
  const store=join(base,'store');
  const repoA=createGitRepo(join(base,'repo-a'));
  const repoB=createGitRepo(join(base,'repo-b'));

  assert.ok(validGitProject(repoA));
  assert.ok(validGitProject(repoB));
  assert.notEqual(projectIdentity(repoA).key,projectIdentity(repoB).key);

  let sessionCount=0,worktreeCount=0;
  const sessions=new Map();
  const worktrees=new Map();

  function mockCtx(repoPath,projectID){
    return {
      location:{directory:repoPath,project:{canonical:repoPath,id:projectID}},
      options:{pilotStore:store,pilotWake:false,nativeDispatch:false,autoBootstrap:false},
      tool:{transform:async()=>{}},
      model:{list:async()=>Object.values(DEFAULT_MODELS).map(m=>({...m,enabled:true,status:'active',variants:[{id:'medium'}]}))},
      session:{
        create:async input=>{
          sessionCount++;
          const id=`ses_mock_${sessionCount}`;
          const sess={id,projectID,agent:'build',location:input.location,model:input.model};
          sessions.set(id,sess);
          return sess;
        },
        get:async({sessionID})=>{
          const sess=sessions.get(sessionID);
          if(!sess)throw Error('SESSION_NOT_FOUND');
          return sess;
        }
      },
      worktree:{
        create:async input=>{
          worktreeCount++;
          const directory=join(base,`wt_${worktreeCount}_${input.name}`);
          execFileSync('git',['-C',repoPath,'worktree','add','--detach',directory],{stdio:'pipe'});
          const wt={id:`wt_${worktreeCount}`,directory};
          worktrees.set(wt.id,wt);
          return wt;
        }
      }
    };
  }

  try{
    const ctxA=mockCtx(repoA,'proj_a_123');
    const ctxB=mockCtx(repoB,'proj_b_456');

    // 1. Initial state: neither repo is auto-provisioned
    const coordA0=await registerOfficialCoordinator(ctxA);
    assert.equal(coordA0.read(),null);
    const coordB0=await registerOfficialCoordinator(ctxB);
    assert.equal(coordB0.read(),null);
    assert.equal(sessionCount,0);
    assert.equal(worktreeCount,0);

    // 2. Explicit bootstrap on repoA
    const teamA=await coordA0.bootstrap();
    assert.equal(teamA.status,'ready');
    assert.equal(teamA.projectID,'proj_a_123');
    assert.equal(teamA.canonicalRoot,repoA);
    assert.equal(teamA.members.length,4);
    for(const m of teamA.members)assert.deepEqual(sessions.get(m.sessionID).model,DEFAULT_MODELS.worker);
    assert.equal(sessionCount,4);
    assert.equal(worktreeCount,4);
    const unavailable=mockCtx(createGitRepo(join(base,'unavailable')),'unavailable');
    unavailable.model.list=async()=>[];
    const rejected=new OfficialCoordinator(unavailable);
    await assert.rejects(rejected.bootstrap(),/DEFAULT_MODEL_UNAVAILABLE/);
    assert.equal(rejected.read(),null);
    assert.equal(sessionCount,4);

    // 3. RepoB remains unprovisioned
    assert.equal(coordB0.read(),null);

    // 4. Reload repoA: reuses existing team, zero new sessions or worktrees
    const coordA1=await registerOfficialCoordinator(ctxA);
    const reloadedA=coordA1.read();
    assert.equal(reloadedA.teamID,teamA.teamID);
    assert.deepEqual(reloadedA.members.map(m=>m.sessionID),teamA.members.map(m=>m.sessionID));
    assert.equal(sessionCount,4);
    assert.equal(worktreeCount,4);

    // 5. Explicit bootstrap on repoB
    const teamB=await coordB0.bootstrap();
    assert.equal(teamB.status,'ready');
    assert.equal(teamB.projectID,'proj_b_456');
    assert.equal(teamB.canonicalRoot,repoB);
    assert.notEqual(teamB.teamID,teamA.teamID);
    assert.equal(sessionCount,8);
    assert.equal(worktreeCount,8);

    // Disjoint sessions and directories
    const sessionsA=new Set(teamA.members.map(m=>m.sessionID));
    const sessionsB=new Set(teamB.members.map(m=>m.sessionID));
    for(const s of sessionsB)assert.ok(!sessionsA.has(s));

    const dirsA=new Set(teamA.members.map(m=>m.directory));
    const dirsB=new Set(teamB.members.map(m=>m.directory));
    for(const d of dirsB)assert.ok(!dirsA.has(d));

    // 6. Cross-project isolation: member of repoA cannot call coordinator of repoB
    const adminA=teamA.members[0];
    const adminB=teamB.members[0];
    const worker1A=teamA.members[1];

    const callerForeign={...ctxB,location:{...ctxB.location,directory:adminA.directory}};
    const coordForeign=new OfficialCoordinator(callerForeign);
    await assert.rejects(
      coordForeign.execute('inbox',{},{sessionID:adminA.sessionID,agent:adminA.agent}),
      /PILOT_MEMBER_REQUIRED/
    );

    // 7. Owner -> Admin messaging in Project A
    const ownerMsg=await coordA1.ownerSend({recipient:'peer-1',text:'Owner instruction for Project A'});
    assert.equal(ownerMsg.from,'owner');
    assert.equal(ownerMsg.to,'peer-1');
    assert.equal(ownerMsg.text,'Owner instruction for Project A');
    assert.ok(ownerMsg.requestID);

    // Validate invalid Owner messages
    await assert.rejects(coordA1.ownerSend({recipient:'foreign-peer',text:'Foreign forbidden'}),/PILOT_RECIPIENT_INVALID/);
    await assert.rejects(coordA1.ownerSend({recipient:'admin',text:''}),/PILOT_TEXT_REQUIRED/);

    // Owner message appears in Project A inbox, NOT in Project B
    const coordAAdmin=new OfficialCoordinator({...ctxA,location:{...ctxA.location,directory:adminA.directory}});
    const inboxAdminA=await coordAAdmin.execute('inbox',{},{sessionID:adminA.sessionID,agent:adminA.agent});
    assert.ok(inboxAdminA.messages.some(m=>m.id===ownerMsg.id));

    const coordBAdmin=new OfficialCoordinator({...ctxB,location:{...ctxB.location,directory:adminB.directory}});
    const inboxAdminB=await coordBAdmin.execute('inbox',{},{sessionID:adminB.sessionID,agent:adminB.agent});
    assert.equal(inboxAdminB.messages.length,0);

    // 8. Admin -> Worker messaging with omitted requestID
    const assignMsg=await coordAAdmin.execute('assign',{recipient:'peer-2',text:'Work on feature A'},{sessionID:adminA.sessionID,agent:adminA.agent});
    assert.equal(assignMsg.from,'peer-1');
    assert.equal(assignMsg.to,'peer-2');
    assert.ok(assignMsg.requestID);

    // 9. Worker -> Admin reporting with omitted requestID
    const coordAWorker1=new OfficialCoordinator({...ctxA,location:{...ctxA.location,directory:worker1A.directory}});
    const replyMsg=await coordAWorker1.execute('send',{recipient:'peer-1',text:'Feature A done',taskID:assignMsg.taskID},{sessionID:worker1A.sessionID,agent:worker1A.agent});
    assert.equal(replyMsg.from,'peer-2');
    assert.equal(replyMsg.to,'peer-1');
    assert.ok(replyMsg.requestID);

    // 10. Admin -> Owner reporting
    const adminToOwner=await coordAAdmin.execute('send',{recipient:'owner',text:'Task completed for Owner'},{sessionID:adminA.sessionID,agent:adminA.agent});
    assert.equal(adminToOwner.from,'peer-1');
    assert.equal(adminToOwner.to,'owner');

    // 11. Worker cannot message Owner directly
    assert.equal((await coordAWorker1.execute('send',{recipient:'owner',text:'Peer direct'},{sessionID:worker1A.sessionID,agent:worker1A.agent})).from,'peer-2');

  }finally{
    rmSync(base,{recursive:true,force:true});
  }
});
