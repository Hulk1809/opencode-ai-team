import test from 'node:test';
import assert from 'node:assert/strict';
import {openAdminChat} from '../src/pilot-admin-chat.mjs';

test('Admin chat opens only coordinator Admin on snapshot server, never sends a prompt',()=>{
  const calls=[];
  const current={id:'ses_worker',directory:'/project',server:{id:'sidecar'}};
  const ctx={sessions:{current:()=>current},tabs:{open:(...args)=>calls.push(args)}};
  const snapshot={serverID:'sidecar',directory:'/project',team:{members:[{role:'worker-1',sessionID:'ses_worker'},{role:'admin',sessionID:'ses_admin'}]}};
  openAdminChat(ctx,snapshot);
  assert.deepEqual(calls,[[{server:'sidecar',id:'ses_admin'},{focus:true}]]);
  for(const invalid of [undefined,{...snapshot,serverID:'remote'},{...snapshot,directory:'/other'},{...snapshot,team:{members:[]}},{...snapshot,team:{members:[{role:'admin',sessionID:'arbitrary'}]}},{...snapshot,team:{members:[{role:'admin',sessionID:'ses_a'},{role:'admin',sessionID:'ses_b'}]}}])assert.throws(()=>openAdminChat(ctx,invalid),/PILOT_ADMIN_CHAT_UNAVAILABLE/);
  current.server.id='remote';
  assert.throws(()=>openAdminChat(ctx,snapshot),/PILOT_ADMIN_CHAT_UNAVAILABLE/);
  assert.equal(calls.length,1);
});
