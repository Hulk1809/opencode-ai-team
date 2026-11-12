import test from 'node:test';
import assert from 'node:assert/strict';
import {executionAuthorization} from '../src/host-owner-bridge.mjs';

test('execution status requires verified signature and current approved plan',()=>{
  const state={executionPolicy:{planID:'p',planVersion:1,digest:'d'},plans:[{planID:'p',version:1,digest:'d',ownerDecision:'approve'}]};
  const verify=()=>true;
  assert.equal(executionAuthorization(state,verify).authorized,true);
  assert.deepEqual(executionAuthorization(state,()=>{throw Error('PEER_NATIVE_POLICY_SIGNATURE_INVALID')}),{authorized:false,reason:'PEER_NATIVE_POLICY_SIGNATURE_INVALID'});
  for(const change of [{revokedAt:1},{planVersion:2},{digest:'other'}]){
    assert.equal(executionAuthorization({...state,executionPolicy:{...state.executionPolicy,...change}},verify).authorized,false);
  }
  assert.equal(executionAuthorization({...state,plans:[{...state.plans[0],needsOwner:true}]},verify).authorized,false);
});
