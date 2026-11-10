import {consumeOwnerGrant} from './pilot-owner-authority.mjs';
import {planHash,PEER_GENERATION} from './peer-team.mjs';
import {requestCancellation} from './peer-native.mjs';

export async function cancelExecutionRPC(coordinator,input){
  if(!input||Object.keys(input).some(k=>!['directory','authorization','generation','requestID','executionID','identity'].includes(k))||input.directory!==coordinator.root||input.generation!==PEER_GENERATION||typeof input.executionID!=='string'||!input.identity)throw Error('PILOT_OWNER_AUTHORIZATION_REQUIRED');
  consumeOwnerGrant(input.authorization,{root:coordinator.root,projectID:coordinator.ctx.location.project.id,operation:'cancelExecution',generation:input.generation,requestID:input.requestID,planHash:planHash({executionID:input.executionID,identity:input.identity})});
  return requestCancellation(coordinator,input.executionID,input.requestID,input.identity);
}
