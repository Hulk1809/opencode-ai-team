import {createHash,randomUUID} from 'node:crypto';
import {memberID} from './peer-team.mjs';

// ADAPT: Ensemble durable messages; per-recipient acknowledgement never wakes a model.
export function inbox(state,member){
  return state.messages.filter(m=>m.to===memberID(member)||m.to==='team').map(m=>({...m,receipt:state.receipts?.find(r=>r.messageID===m.id&&r.memberID===memberID(member))??null}));
}
export function acknowledge(state,member,input){
  if(!input||Object.keys(input).some(k=>!['messageID','requestID'].includes(k))||!['messageID','requestID'].every(k=>typeof input[k]==='string'&&input[k].length>0&&input[k].length<=160))throw Error('PEER_RECEIPT_INVALID');
  const message=inbox(state,member).find(m=>m.id===input.messageID);
  if(!message)throw Error('PEER_MESSAGE_FORBIDDEN');
  state.receipts??=[];
  const old=state.receipts.find(r=>r.memberID===memberID(member)&&r.requestID===input.requestID);
  if(old){if(old.messageID!==input.messageID||old.sessionID!==member.sessionID)throw Error('PEER_RECEIPT_IDEMPOTENCY_CONFLICT');return old;}
  const existing=state.receipts.find(r=>r.memberID===memberID(member)&&r.messageID===input.messageID);
  if(existing)return existing;
  const receipt={id:randomUUID(),messageID:message.id,requestID:input.requestID,memberID:memberID(member),sessionID:member.sessionID,contentDigest:createHash('sha256').update(message.text).digest('hex'),state:'acknowledged',at:new Date().toISOString()};
  state.receipts.push(receipt);return receipt;
}
