import {createHash,randomUUID} from 'node:crypto';
import {memberID} from './peer-team.mjs';

export function queueMessages(state){
  if(state?.mode!=='peer'||!state.collaboration?.enabled)return;
  state.deliveries??=[];
  for(const message of state.messages){
    if(!['send','handoff'].includes(message.action)||Date.parse(message.at)<state.collaboration.enabledAt)continue;
    const mentions=[...message.text.matchAll(/@((?:peer-)[1-9][0-9]*)\b/g)].map(m=>m[1]);
    const targets=state.members.filter(m=>memberID(m)!==message.from&&(message.to==='team'||message.to===memberID(m)||mentions.includes(memberID(m))));
    for(const m of targets)if(!state.deliveries.some(d=>d.messageID===message.id&&d.memberID===memberID(m)))state.deliveries.push({messageID:message.id,memberID:memberID(m),sessionID:m.sessionID,promptID:`msg_${createHash('sha256').update(`${state.teamID}:${message.id}:${m.sessionID}`).digest('hex').slice(0,32)}`,status:'queued'});
  }
}

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
