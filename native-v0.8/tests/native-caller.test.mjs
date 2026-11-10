import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCaller} from '../src/native-caller.mjs';
test('host caller binds exact registry/project/agent/worktree; cross-location denied',async()=>{
  const session={id:'fixture-member',agent:'backend',metadata:{teamDirectory:'/fixture'},location:{directory:'/fixture/tree'}};
  const ctx={location:{directory:'/fixture'},session:{get:async()=>session}};
  const team={status:'ready',directory:'/fixture',members:{backend:{role:'backend',sessionID:session.id,directory:'/fixture/tree'}}};
  const room={read:async()=>team};
  assert.equal((await nativeCaller(ctx,room,session.id)).role,'backend');
  await assert.rejects(nativeCaller(ctx,room,'forged'),/BINDING_MISMATCH/);
  session.agent='admin';await assert.rejects(nativeCaller(ctx,room,session.id),/BINDING_MISMATCH/);
  session.agent='backend';ctx.location.directory='/other';await assert.rejects(nativeCaller(ctx,room,session.id),/LOCATION_UNAVAILABLE/);
});
test('host lookup rejects foreign project and registry/location mismatches',async()=>{
  const directory='/fixture/canonical';
  const session={id:'fixture-backend',projectID:'fixture-project',agent:'backend',metadata:{teamDirectory:directory},location:{directory:'/fixture/backend'}};
  const ctx={location:{directory,project:{id:'fixture-project'}},session:{get:async()=>structuredClone(session)}};
  const team={status:'ready',directory,projectID:'fixture-project',members:{backend:{role:'backend',sessionID:session.id,directory:'/fixture/backend'}}};
  const room={read:async()=>structuredClone(team)};
  assert.equal((await nativeCaller(ctx,room,session.id)).role,'backend');
  delete team.projectID;await assert.rejects(nativeCaller(ctx,room,session.id),/BINDING_MISMATCH/);team.projectID='fixture-project';
  session.projectID='foreign';await assert.rejects(nativeCaller(ctx,room,session.id),/PROJECT_MISMATCH/);
  session.projectID='fixture-project';session.location.directory='/foreign/tree';
  await assert.rejects(nativeCaller(ctx,room,session.id),/BINDING_MISMATCH/);
  session.location.directory='/fixture/backend';team.members.backend.sessionID='different-member';
  await assert.rejects(nativeCaller(ctx,room,session.id),/BINDING_MISMATCH/);
});
