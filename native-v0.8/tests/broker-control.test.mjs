import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {withBrokerLedger,digest} from '../src/broker.mjs';
import {brokerControl} from '../src/broker-control.mjs';
import {brokerStore} from '../src/broker-store.mjs';
test('Owner-signed epoch advance supersedes old completion lookup; Admin cannot rebind',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),dir=await mkdtemp('/tmp/opencode/completion-epoch-');
  await withBrokerLedger(dir,async ledger=>{
    let state={scopes:{},requests:[]};
    const control=brokerControl({ledger,ownerPublicKey:publicKey,load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);}});
    const signed=(acceptanceEpoch,epoch)=>{
      const manifest=Buffer.from(JSON.stringify({projectID:'p',scopeID:'s',members:[{role:'admin',sessionID:'a'}],tasks:[{taskID:'t',revision:'r',snapshotHash:'0'.repeat(64),acceptanceEpoch}]}));
      const bytes=Buffer.from(JSON.stringify({operation:'approve',nonce:`n${acceptanceEpoch}-${epoch}`,epoch,projectID:'p',scopeID:'s',manifestHash:digest(manifest),expiresAt:Date.now()+60000}));
      return {decision:bytes.toString('base64'),signature:sign(null,bytes,privateKey).toString('base64'),manifest:manifest.toString('base64')};
    };
    const admin={kind:'admin',projectID:'p',sessionID:'a'},input={projectID:'p',scopeID:'s',taskID:'t',revision:'r',snapshotHash:'0'.repeat(64),acceptanceEpoch:0,epoch:0};
    await control.handlers.approve({kind:'owner'},signed(0,0));
    assert.equal(await control.handlers.completionStatus(admin,input),null);
    await assert.rejects(control.handlers.approve(admin,signed(1,1)),/Owner/);
    await assert.rejects(control.handlers.approve({kind:'owner'},signed(0,1)),/epoch not advanced/);
    await control.handlers.approve({kind:'owner'},signed(1,0));
    await assert.rejects(control.handlers.completionStatus(admin,input),/superseded/);
    assert.equal(await control.handlers.completionStatus(admin,{...input,acceptanceEpoch:1}),null);
  },publicKey);
});
test('durable submit deduplicates, caller status isolated, concurrent signed revoke enters during execution',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),dir=await mkdtemp('/tmp/opencode/control-');
  await withBrokerLedger(dir,async ledger=>{
    let state={scopes:{},requests:[]},release,entered;const started=new Promise(r=>entered=r);let executions=0,stops=0;
    const c=brokerControl({ledger,ownerPublicKey:publicKey,load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},execute:async()=>{executions++;entered();return new Promise(r=>release=r);},stopScope:async()=>{stops++;}});
    const manifest=Buffer.from(JSON.stringify({projectID:'p',scopeID:'s',members:[{sessionID:'backend'}]}));
    const signed=(operation,nonce,epoch)=>{const b=Buffer.from(JSON.stringify({operation,nonce,epoch,projectID:'p',scopeID:'s',manifestHash:digest(manifest),expiresAt:Date.now()+60000}));return {decision:b.toString('base64'),signature:sign(null,b,privateKey).toString('base64'),manifest:manifest.toString('base64')};};
    await c.handlers.approve({kind:'owner'},signed('approve','n1',0));
    const peer={kind:'agent',projectID:'p',sessionID:'backend'},input={scopeID:'s',epoch:0,requestID:'r',taskID:'t',goal:'test',files:[]};
    const job=await c.handlers.submit(peer,input);await started;
    assert.equal((await c.handlers.submit(peer,input)).jobID,job.jobID);assert.equal(executions,1);
    await assert.rejects(c.handlers.submit(peer,{...input,goal:'verify'}),/different/);
    await assert.rejects(c.handlers.status({...peer,projectID:'other'},{jobID:job.jobID}),/visible/);
    await assert.rejects(c.handlers.approve(peer,signed('approve','fake',0)),/Owner/);
    await c.handlers.revoke({kind:'owner'},signed('revoke','n2',1));assert.equal(stops,1);
    release({exitCode:0});await c.idle();assert.equal((await c.handlers.status(peer,{jobID:job.jobID})).state,'revoked');
    state.requests.push({id:'lost',state:'running'});await c.recover();assert.equal(state.requests.at(-1).state,'uncertain');assert.equal(executions,1);
  },publicKey);
});
test('request store reopen preserves uncertain admission without replay',async()=>{
  const dir=await mkdtemp('/tmp/opencode/reconnect-'),store=brokerStore(dir);
  await store.save({scopes:{},requests:[{id:'admitted-before-crash',state:'running',projectID:'p',sessionID:'s'}]});
  let calls=0;const reopened=brokerStore(dir),control=brokerControl({ledger:{},...reopened,execute:async()=>{calls++;},stopScope:async()=>{}});
  await control.recover();assert.equal((await reopened.load()).requests[0].state,'uncertain');assert.equal(calls,0);
});

test('scope expiry stops running execution and late success cannot publish evidence',async()=>{
  let state={scopes:{'["p","s"]':{manifest:'{}'}},requests:[]},valid=true,release,entered;
  const started=new Promise(resolve=>entered=resolve);let stops=0;
  const ledger={authorize:()=>{if(!valid)throw Error('Scope denied');}};
  const c=brokerControl({ledger,load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},execute:async()=>{entered();return new Promise(resolve=>release=resolve);},stopScope:async()=>{stops++;}});
  state.scopes['["p","s"]'].manifest=JSON.stringify({members:[{sessionID:'b'}]});
  const peer={projectID:'p',sessionID:'b'},job=await c.handlers.submit(peer,{requestID:'r',scopeID:'s',epoch:0});
  await started;valid=false;await c.expire();assert.equal(stops,1);
  release({exitCode:0});await c.idle();
  const result=await c.handlers.status(peer,{jobID:job.jobID});assert.equal(result.state,'expired');assert.equal(result.result,undefined);
});

test('failed scope stop stays uncertain and late executor cannot replace it with success',async()=>{
  let state={scopes:{'["p","s"]':{manifest:JSON.stringify({members:[{sessionID:'b'}]})}},requests:[]},valid=true,release,entered;
  const started=new Promise(resolve=>entered=resolve);let failStop=true;
  const c=brokerControl({ledger:{authorize:()=>{if(!valid)throw Error('Scope denied');}},load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},execute:async()=>{entered();return new Promise(resolve=>release=resolve);},stopScope:async()=>{if(failStop)throw Error('Stop failed');}});
  const peer={projectID:'p',sessionID:'b'},job=await c.handlers.submit(peer,{requestID:'r',scopeID:'s',epoch:0});
  await started;valid=false;await assert.rejects(c.expire(),/Stop failed/);
  release({exitCode:0});await c.idle();
  const result=await c.handlers.status(peer,{jobID:job.jobID});assert.equal(result.state,'uncertain');assert.equal(result.result,undefined);
  assert.equal(result.stopReason,'expired');
  failStop=false;await c.expire();assert.equal((await c.handlers.status(peer,{jobID:job.jobID})).state,'expired');
});
