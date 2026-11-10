import {createHash} from 'node:crypto';

export const PEER_GENERATION='v08-peer-1';
export const memberID=member=>member.id??member.role;
export const memberLabel=member=>member.label??member.role;
export function peerPlan(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['members','generation'].includes(k))||input.generation!==undefined&&input.generation!==PEER_GENERATION)throw Error('PEER_PLAN_INVALID');
  const members=input.members===undefined?Array.from({length:4},(_,i)=>({id:`peer-${i+1}`,label:`Peer ${i+1}`})):input.members;
  if(!Array.isArray(members)||!members.length||members.length>16)throw Error('PEER_MEMBERS_INVALID');
  const ids=new Set();
  return {generation:PEER_GENERATION,members:members.map(m=>{
    if(!m||Object.keys(m).some(k=>!['id','label'].includes(k))||typeof m.id!=='string'||!/^peer-[a-z0-9-]{1,48}$/.test(m.id)||ids.has(m.id)||typeof m.label!=='string'||!m.label.trim()||m.label.length>80)throw Error('PEER_MEMBERS_INVALID');
    ids.add(m.id);return {id:m.id,label:m.label.trim()};
  })};
}
export const planHash=plan=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
// Legacy history/role IDs stay byte-for-byte intact; version is a read projection only.
export function teamView(state){return state?{...state,schemaVersion:state.schemaVersion??1,mode:state.mode??'legacy'}:state;}
