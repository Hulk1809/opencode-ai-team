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
