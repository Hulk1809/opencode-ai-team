import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {TeamRoom} from '../src/room.mjs';
import {TeamPersistence,checkWorktree,dataDirectory} from '../src/persistence.mjs';

test('persistent backup restores exact IDs/artifact bytes paused; refuses overwrite, corruption and replay',async()=>{
  const root=await mkdtemp(join('/tmp/opencode','persistence-check-')),storage=new Map();
  const room=new TeamRoom({storage:{get:async k=>structuredClone(storage.get(k)),set:async(k,v)=>storage.set(k,structuredClone(v))}});
  const directory='/persistent-project',id='11111111-1111-4111-8111-111111111111',bytes=Buffer.from('file round trip\n');
  const artifact={id,base64:bytes.toString('base64'),checksum:createHash('sha256').update(bytes).digest('hex'),acl:['owner']};
  const team={directory,status:'ready',members:{},tasks:[{id:'task',status:'done',completionRevision:2}],files:[{id}],messages:[{id:'request',promptID:'prompt',status:'admitted'}]};
  await room.write(directory,team);storage.set(`files/${encodeURIComponent(directory)}/${id}`,artifact);
  const persistence=new TeamPersistence(room,root),backup=await persistence.backup(directory);
  assert.equal((await stat(backup.path)).mode&0o777,0o600);
  await assert.rejects(persistence.restore(directory,backup.id),/đã tồn tại/);
  // Fresh storage models loss; never delete or reset original state.
  const restoredStorage=new Map(),restored=new TeamRoom({storage:{get:async k=>structuredClone(restoredStorage.get(k)),set:async(k,v)=>restoredStorage.set(k,structuredClone(v))}});
  const recovery=new TeamPersistence(restored,root);await recovery.restore(directory,backup.id);
  const result=await restored.read(directory);assert.deepEqual(result.tasks,team.tasks);assert.equal(result.messages[0].status,'admitted');assert.equal(result.recovery.paused,true);
  assert.deepEqual(Buffer.from(restoredStorage.get(`files/${encodeURIComponent(directory)}/${id}`).base64,'base64'),bytes);
  await restored.drain(directory);assert.equal((await restored.read(directory)).messages[0].status,'admitted');
  const envelope=JSON.parse(await readFile(backup.path,'utf8'));envelope.payload+=' ';await writeFile(backup.path,JSON.stringify(envelope));
  await assert.rejects(recovery.restore(directory,backup.id),/checksum/);
  await assert.rejects(recovery.restore(directory,'../bad'),/ID/);
  assert.ok(!dataDirectory().startsWith('/tmp/'));
});

test('missing coding worktree blocks request with evidence and zero model calls',async()=>{
  await assert.rejects(checkWorktree('/tmp/opencode/no-such-worktree','/tmp/opencode/no-repository'));
  const storage=new Map();let calls=0;
  const room=new TeamRoom({storage:{get:async k=>structuredClone(storage.get(k)),set:async(k,v)=>storage.set(k,structuredClone(v))},session:{prompt:async()=>{calls++;}}});
  await room.write('/missing-project',{members:{backend:{role:'backend',sessionID:'s',writable:true,directory:'/tmp/opencode/no-such-worktree'}},tasks:[{id:'t',status:'working'}],messages:[{id:'r',to:'backend',taskID:'t',status:'waiting',kind:'execution'}]});
  await room.drain('/missing-project');const state=await room.read('/missing-project');
  assert.equal(calls,0);assert.equal(state.messages[0].status,'waiting');assert.equal(state.messages[0].executionState,'Blocked');assert.ok(state.messages[0].workspaceError);
});
