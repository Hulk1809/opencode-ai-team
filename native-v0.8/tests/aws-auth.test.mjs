import test from 'node:test';
import assert from 'node:assert/strict';
import {awsAuth} from '../src/aws-auth.mjs';
test('AWS optional project workflow stays blocked; role checks and metadata-only trust boundary',async()=>{
  const states=new Map([['p',{messages:[]}],['other',{messages:[]}]]),room={exclusive:async(d,f)=>f(),read:async d=>structuredClone(states.get(d)),write:async(d,t)=>states.set(d,structuredClone(t))};
  const p={account:'123456789012',environment:'sandbox',purpose:'Read inventory',scope:'sts:GetCallerIdentity only',profile:'sandbox',method:'sso-device-code'};
  await assert.rejects(awsAuth(room,'p','admin','aws_propose',p),/DevOps/);
  await assert.rejects(awsAuth(room,'p','devops','aws_propose',{...p,token:'secret'}),/metadata/);
  const row=await awsAuth(room,'p','devops','aws_propose',p);
  await assert.rejects(awsAuth(room,'other','admin','aws_request',{requestID:row.id}),/project/);
  await awsAuth(room,'p','admin','aws_request',{requestID:row.id});
  await assert.rejects(awsAuth(room,'p','admin','aws_confirm',{requestID:row.id,confirm:true}),/Owner/);
  const blocked=await awsAuth(room,'p','owner','aws_confirm',{requestID:row.id,confirm:true});
  assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.approvalValid,false);assert.equal(blocked.cliSupport,'UNVERIFIED');assert.equal(blocked.url,undefined);
  assert.equal(states.get('other').awsAuth,undefined);
  assert.equal((await awsAuth(room,'p','devops','aws_propose',{...p,method:'login-remote'})).method,'login-remote');
});
