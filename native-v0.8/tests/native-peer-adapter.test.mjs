import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,openSync,closeSync,symlinkSync} from 'node:fs';
import net from 'node:net';
import {join} from 'node:path';
import {OfficialCoordinator,runInBwrapSandbox} from '../src/official-coordinator.mjs';
import {NativePeerAdapter} from '../src/native-peer-adapter.mjs';
import {executionIdentity,hasVerifiedStop} from '../src/peer-native.mjs';
import {startHostOwnerBridge,verifyHostOwnerBridgeTicket} from '../src/host-owner-bridge.mjs';
import {issueOwnerGrant} from '../src/pilot-owner-authority.mjs';

function fixture(t){
  const root=mkdtempSync('/tmp/native-peer-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const member={id:'peer-1',sessionID:'s1',agent:'build',directory:root,modelDefault:{providerID:'fixture',id:'controlled'}};
  const task={id:'t1',text:'Inspect fixture',acceptanceCriteria:['Report evidence'],assignee:member.id,planID:'p1',planVersion:1,ownershipGeneration:1,workRevision:1,status:'RUNNING',executionState:'outstanding',lease:{id:'l1',expiresAt:Date.now()+60000}};
  const state={projectID:'project',teamID:'team',members:[member],tasks:[task],plans:[{planID:'p1',version:1,digest:'digest',content:'Read only',ownerDecision:'approve'}],
    executionPolicy:{planID:'p1',planVersion:1,digest:'digest',maxActive:1,maxAttemptsPerTask:1,maxCalls:1,usedCalls:0,timeoutMs:1000,models:[member.modelDefault]}};
  state.executions=[{id:'e1',sessionID:'s1',taskID:'t1',identity:executionIdentity(state,task),state:'admitted-by-adapter'}];
  let calls=0,rows=[],lose=false;
  const ctx={location:{project:{canonical:root,id:'project'}},options:{pilotStore:root},session:{get:async()=>({id:'s1',projectID:'project',agent:'build',location:{directory:root},model:member.modelDefault}),active:async()=>({}),context:async()=>rows,prompt:async input=>{calls++;if(lose)throw Error('lost response');return {id:input.id};}}};
  const c=new OfficialCoordinator(ctx);c.mutate(()=>({state}));
  return {c,ctx,get calls(){return calls;},set rows(value){rows=value;},set lose(value){lose=value;}};
}
test('default authority denies; atomic submission prevents concurrent duplicate prompts',async t=>{
  const f=fixture(t);
  await assert.rejects(new NativePeerAdapter(f.c).dispatch('e1'),/ADMISSION_BLOCKED/);assert.equal(f.calls,0);
  f.c.mutate(s=>{delete s.executionPolicy;return {};});
  await assert.rejects(new NativePeerAdapter(f.c,{authorize:()=>true}).dispatch('e1'),/POLICY_REQUIRED/);assert.equal(f.calls,0);
  f.c.mutate(s=>{s.executionPolicy={planID:'p1',planVersion:1,digest:'digest',maxActive:1,maxAttemptsPerTask:1,maxCalls:1,usedCalls:0,timeoutMs:1000,models:[s.members[0].modelDefault]};return {};});
  const a=new NativePeerAdapter(f.c,{authorize:()=>true});
  await Promise.all([a.dispatch('e1'),a.dispatch('e1')]);assert.equal(f.calls,1);
  assert.equal(f.c.read().tasks[0].status,'RUNNING');assert.equal(f.c.read().executions[0].result,undefined);
  await new NativePeerAdapter(new OfficialCoordinator(f.ctx)).dispatch('e1');assert.equal(f.calls,1);
});
test('lost admission response survives restart without resend',async t=>{
  const f=fixture(t);f.lose=true;
  await assert.rejects(new NativePeerAdapter(f.c,{authorize:()=>true}).dispatch('e1'),/lost response/);
  await new NativePeerAdapter(new OfficialCoordinator(f.ctx)).dispatch('e1');
  assert.equal(f.calls,1);assert.equal(f.c.read().executions[0].submission.state,'uncertain');
});
test('only correlated assistant plus terminal records result; never marks task done',async t=>{
  const f=fixture(t),a=new NativePeerAdapter(f.c,{authorize:()=>true});const row=await a.dispatch('e1');
  f.rows=[{type:'idle',id:'old',outcome:'succeeded'}];assert.equal((await a.reconcile('e1')).result,undefined);
  const user={type:'user',id:row.submission.id},assistant={type:'assistant',id:'a1'},idle={type:'idle',id:'i1',outcome:'succeeded'};
  f.rows=[user,idle];assert.equal((await a.reconcile('e1')).result,undefined);
  f.rows=[user,{type:'user',id:'foreign'},assistant,idle];assert.equal((await a.reconcile('e1')).result,undefined);
  f.rows=[user,assistant,idle];assert.deepEqual((await a.reconcile('e1')).result.assistantIDs,['a1']);
  assert.equal(f.c.read().tasks[0].status,'RUNNING');assert.equal(f.c.read().tasks[0].executionState,'outstanding');
});
test('revocation, stale lease and changed model prevent admission',async t=>{
  for(const change of [s=>s.plans[0].ownerDecision='reject',s=>s.tasks[0].lease.expiresAt=0,s=>s.members[0].modelDefault.id='other',
    s=>s.executionPolicy.revokedAt=1,s=>s.executionPolicy.digest='other',s=>s.executionPolicy.usedCalls=1,s=>s.executionPolicy.models=[],
    s=>s.executions.push({id:'busy',taskID:'x',sessionID:'other',submission:{id:'m'}})]){
    const f=fixture(t);f.c.mutate(s=>{change(s);return {};});
    await assert.rejects(new NativePeerAdapter(f.c,{authorize:()=>true}).dispatch('e1'));
    assert.equal(f.calls,0);
  }
});
test('timeout requests one interrupt without resend; token usage measured from session delta',async t=>{
  const f=fixture(t),a=new NativePeerAdapter(f.c,{authorize:()=>true});let interrupts=0;
  f.ctx.session.interrupt=async()=>{interrupts++;};
  const row=await a.dispatch('e1');
  f.rows=[{type:'user',id:row.submission.id}];
  assert.equal((await a.reconcile('e1',row.submission.deadline+1)).cancellation.requestID,'timeout:e1');
  await a.reconcile('e1',row.submission.deadline+2);assert.equal(interrupts,1);assert.equal(f.calls,1);
  assert.equal(f.c.read().executionPolicy.usedCalls,1);
});
test('verifyStop blocks while running/queued, proves terminal or unsubmitted stop, and fences stale retries',async t=>{
  const f=fixture(t),a=new NativePeerAdapter(f.c,{authorize:()=>true});
  let outcome='interrupted',active={s1:true};
  f.ctx.session.get=async()=>({id:'s1',projectID:'project',agent:'build',location:{directory:f.c.root},model:f.c.read().members[0].modelDefault,outcome});
  f.ctx.session.active=async()=>active;
  active={};
  const row=await a.dispatch('e1');
  active={s1:true};f.rows=[{type:'user',id:row.submission.id}];
  await assert.rejects(a.verifyStop('e1'),/PEER_STOP_NOT_PROVEN/);
  active={};
  await assert.rejects(a.verifyStop('e1'),/PEER_STOP_NOT_PROVEN/);
  f.rows=[{type:'user',id:row.submission.id},{type:'assistant',id:'a1'},{type:'idle',id:'i1',outcome:'interrupted'}];
  const verified=await a.verifyStop('e1');
  assert.equal(verified.state,'stop-verified');
  assert.equal(verified.stopReceipt.receiptID,`stop:e1:${row.submission.id}:i1`);
  assert.equal(hasVerifiedStop(f.c.read(),f.c.read().tasks[0]),true);
  assert.equal(f.c.read().tasks[0].executionState,'stopped');
  assert.deepEqual(await a.verifyStop('e1'),verified);
  f.c.mutate(s=>{s.tasks[0].ownershipGeneration++;return {};});
  await assert.rejects(a.verifyStop('e1'),/PEER_EXECUTION_STALE/);
});
test('host owner bridge prevents same-UID file grant, socket minting, and rogue socket forgery',async t=>{
  const dir=mkdtempSync('/tmp/b4-bridge-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const prevDir=process.env.OPENCODE_OWNER_AUTHORITY_DIR,prevHome=process.env.HOME;
  process.env.OPENCODE_OWNER_AUTHORITY_DIR=dir;process.env.HOME=dir;
  t.after(()=>{process.env.OPENCODE_OWNER_AUTHORITY_DIR=prevDir;process.env.HOME=prevHome;});
  const win={id:7,isDestroyed:()=>false};
  let allowDialog=true;
  const bridge=await startHostOwnerBridge(dir,{hostVersion:'2.2.6',getWindows:()=>[win],confirmDialog:async()=>allowDialog});
  t.after(()=>bridge.close());
  const binding={root:dir,canonical:dir,projectID:'p1',teamID:'t1',generation:'g1',requestID:'r1',operation:'authorizeExecution',planID:'plan-1',planVersion:1,planDigest:'dig-1',taskID:'task-1',sessionID:'s1',model:{providerID:'taile',id:'m1'}};

  // 1. Same-UID file grant (pilot-owner-authority.mjs) is rejected by host bridge verifier.
  const fileGrant=issueOwnerGrant({root:dir,projectID:'p1',operation:'ownerPlan',generation:'g1',requestID:'r1',planHash:'a'.repeat(64)});
  await assert.rejects(verifyHostOwnerBridgeTicket(fileGrant,binding),/OWNER_TICKET_INVALID/);
  await assert.rejects(verifyHostOwnerBridgeTicket('b'.repeat(64),binding),/OWNER_TICKET_NOT_FOUND/);

  // 2. Same-UID process reading owner-authority.key cannot mint over socket.
  const leakedKey=readFileSync(bridge.keyPath,'utf8').trim();
  const socketMint=await new Promise(resolve=>{
    const c=net.createConnection(bridge.socketPath);let out='';
    c.on('connect',()=>c.write(JSON.stringify({op:'testControl',action:'mintTestTicket',key:leakedKey,canonical:dir,projectID:'p1',teamID:'t1',generation:'g1',sessionID:'s1',requestID:'r1'})+'\n'));
    c.on('data',d=>{out+=d;});c.on('end',()=>resolve(JSON.parse(out)));
  });
  assert.equal(socketMint.ok,false);assert.equal(socketMint.reason,'OWNER_SOCKET_MINT_FORBIDDEN');

  // 3. Unverified window or denied dialog cannot issue ticket.
  await assert.rejects(bridge.issueOwnerTicket({window:999,signal:new AbortController().signal},binding),/OWNER_WINDOW_VERIFICATION_REQUIRED/);
  allowDialog=false;
  await assert.rejects(bridge.issueOwnerTicket({window:7,signal:new AbortController().signal},binding),/OWNER_CONFIRMATION_DENIED/);

  // 4. Verified Caller.window + dialog issues single-use Ed25519-backed ticket; replay & binding mismatch fail.
  allowDialog=true;
  const issued=await bridge.issueOwnerTicket({window:7,signal:new AbortController().signal},binding);
  await assert.rejects(verifyHostOwnerBridgeTicket(issued.ticket,{...binding,planDigest:'tampered'}),/OWNER_TICKET_BINDING_MISMATCH/);
  const receipt=await verifyHostOwnerBridgeTicket(issued.ticket,binding);
  assert.equal(receipt.ok,true);assert.equal(receipt.ticketID,issued.ticketID);
  await assert.rejects(verifyHostOwnerBridgeTicket(issued.ticket,binding),/OWNER_TICKET_NOT_FOUND/);
});
test('runInBwrapSandbox isolates node --test from authority dir, parent FDs, host /proc, network, and read-only worktree',async t=>{
  const dir=mkdtempSync('/tmp/antigravity/bwrap-unit-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const secret=join(dir,'secret.key');writeFileSync(secret,'secret');
  const wt=join(dir,'wt');
  const {mkdirSync}=await import('node:fs');mkdirSync(wt,{recursive:true});
  writeFileSync(join(wt,'.git'),'gitdir: /tmp/secret-gitdir\n');
  symlinkSync(secret,join(wt,'sym.key'));
  const fd=openSync(secret,'r');t.after(()=>{try{closeSync(fd);}catch{}});
  writeFileSync(join(wt,'check.test.mjs'),`import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
test("isolated",()=>{
  assert.equal(process.env.OPENCODE_WORKER_SANDBOX,"bwrap-v1");
  assert.equal(existsSync(${JSON.stringify(secret)}),false);
  assert.equal(existsSync("sym.key"),false);
  assert.throws(()=>readFileSync(".git","utf8"),/EACCES|EISDIR|ENOENT/);
  assert.throws(()=>writeFileSync("pwn.txt","x"),/EROFS|EACCES/);
  let leakedContent="";
  try{leakedContent=readFileSync("/proc/self/fd/${fd}","utf8");}catch{}
  assert.equal(leakedContent.includes("secret"),false);
  assert.equal(existsSync("/proc/${process.pid}"),false);
});\n`);
  assert.throws(()=>runInBwrapSandbox(dir,['--test','check.test.mjs'],{forbiddenPaths:[dir]}),/PEER_WORKTREE_SANDBOX_FORBIDDEN_MOUNT/);
  const out=runInBwrapSandbox(wt,['--test','check.test.mjs'],{forbiddenPaths:[secret]});
  assert.match(out,/pass 1/);
});
test('pre-call maxCalls=2 budget ceiling blocks before provider prompt',async t=>{
  const f=fixture(t),a=new NativePeerAdapter(f.c,{authorize:()=>true});
  f.c.mutate(s=>{s.executionPolicy.maxCalls=2;s.executionPolicy.maxAttemptsPerTask=3;return {};});
  const row=await a.dispatch('e1');
  assert.equal(f.calls,1);assert.equal(f.c.read().executionPolicy.usedCalls,1);
  f.rows=[{type:'user',id:row.submission.id},{type:'assistant',id:'a1'},{type:'idle',id:'i1',outcome:'succeeded'}];
  await a.reconcile('e1');
  f.c.mutate(s=>{s.executions.push({id:'e2',sessionID:'s1',taskID:'t1',identity:executionIdentity(s,s.tasks[0]),state:'admitted-by-adapter'});return {};});
  const row2=await a.dispatch('e2');
  assert.equal(f.calls,2);assert.equal(f.c.read().executionPolicy.usedCalls,2);
  f.rows=[{type:'user',id:row.submission.id},{type:'assistant',id:'a1'},{type:'idle',id:'i1',outcome:'succeeded'},{type:'user',id:row2.submission.id},{type:'assistant',id:'a2'},{type:'idle',id:'i2',outcome:'succeeded'}];
  await a.reconcile('e2');
  f.c.mutate(s=>{s.executions.push({id:'e3',sessionID:'s1',taskID:'t1',identity:executionIdentity(s,s.tasks[0]),state:'admitted-by-adapter'});return {};});
  await assert.rejects(a.dispatch('e3'),/PEER_NATIVE_BUDGET_EXHAUSTED/);
  assert.equal(f.calls,2);assert.equal(f.c.read().executionPolicy.usedCalls,2);
});
