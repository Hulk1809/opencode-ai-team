import {randomUUID,createHash} from 'node:crypto';
import {redact} from './safety.mjs';

export const requestStatuses=['PENDING_REVIEW','SEEN','EXPIRED','DISMISSED'];
export const unresolvedRequests=rows=>rows.filter(r=>['PENDING_REVIEW','SEEN'].includes(r.status)).length;
// UI bookkeeping only. Never consumed by broker admission or permission checks.
export async function ownerRequests(room,directory,sessionID,action,p,now=Date.now()){
  return room.exclusive(directory,async()=>{
    const team=await room.read(directory);
    if(team?.status!=='ready')throw Error('Team chưa sẵn sàng');
    if(!p||typeof p!=='object'||Array.isArray(p))throw Error('Invalid Owner request payload');
    const allowed=action==='owner_request'?['taskID','content','scope','risk','expiresAt','idempotencyKey']:action==='owner_requests'?['project','status','after','limit','asOf','snapshot']:action==='owner_requests_expire'?[]:['requestID','status'];
    if(Object.keys(p).some(k=>!allowed.includes(k)))throw Error('Unknown Owner request field');
    const rows=team.ownerRequests??[];
    const at=new Date(now).toISOString();
    const expire=()=>{for(const r of rows)if(['PENDING_REVIEW','SEEN'].includes(r.status)&&Date.parse(r.expiresAt)<=now){r.status='EXPIRED';r.history.push({status:'EXPIRED',at});}};
    if(action==='owner_request'){
      const member=Object.values(team.members).find(m=>m.sessionID===sessionID);
      if(!member)throw Error('Registered requester required');
      for(const [key,max] of [['content',4000],['scope',4000],['idempotencyKey',160]]){
        const value=p[key];
        if(typeof value!=='string'||!value.trim()||value.length>max||redact(value)!==value||/https?:\/\/|\b(?:tokens?|secrets?|passwords?|credentials?|device[ _-]?codes?|authorization|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(value))throw Error('Metadata only; no URLs, secrets, tokens or device codes');
      }
      if(!['low','medium','high'].includes(p.risk)||typeof p.expiresAt!=='string'||!Number.isFinite(Date.parse(p.expiresAt)))throw Error('Invalid risk or expiry');
      if(p.taskID!==undefined&&(typeof p.taskID!=='string'||!team.tasks?.some(t=>t.id===p.taskID)))throw Error('Task outside project');
      const input={taskID:p.taskID??null,content:p.content,scope:p.scope,risk:p.risk,expiresAt:new Date(p.expiresAt).toISOString()};
      const inputHash=JSON.stringify(input);
      const old=rows.find(r=>r.requester.sessionID===sessionID&&r.idempotencyKey===p.idempotencyKey);
      if(old){if(old.inputHash!==inputHash)throw Error('Idempotency key payload mismatch');return old;}
      if(Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>now+30*86400000)throw Error('Expiry must be within 30 days');
      const row={...input,requestID:randomUUID(),project:directory,requester:{sessionID,role:member.role,identityVerified:false},createdAt:at,status:'PENDING_REVIEW',idempotencyKey:p.idempotencyKey,inputHash,authorization:false,history:[{status:'PENDING_REVIEW',at}]};
      rows.push(row);team.ownerRequests=rows;await room.write(directory,team);return row;
    }
    if(action==='owner_requests_expire'){
      if(sessionID)throw Error('Expiry bookkeeping requires explicit GUI action');
      expire();await room.write(directory,team);return {authorization:false};
    }
    if(action==='owner_request_update'){
      // Omitted session is GUI bookkeeping, NOT authenticated Owner identity.
      if(sessionID||!['SEEN','DISMISSED'].includes(p.status))throw Error('Review metadata only; no approval');
      const row=rows.find(r=>r.requestID===p.requestID);
      if(!row)throw Error('Request outside project');
      expire();
      if(['PENDING_REVIEW','SEEN'].includes(row.status)&&row.status!==p.status){row.status=p.status;row.history.push({status:p.status,at,identityVerified:false});}
      await room.write(directory,team);return row;
    }
    if(action!=='owner_requests'||p.status!==undefined&&!requestStatuses.includes(p.status))throw Error('Invalid request filter');
    if(p.project!==undefined&&typeof p.project!=='string'||p.after!==undefined&&(!Number.isSafeInteger(p.after)||p.after<0)||p.limit!==undefined&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>100)||p.asOf!==undefined&&(!Number.isSafeInteger(p.asOf)||p.asOf<0||p.asOf>rows.length))throw Error('Invalid pagination');
    // ponytail: expiry is a read projection until explicit UI mutation persists it.
    const asOf=p.asOf??rows.length;
    const visible=structuredClone(rows.slice(0,asOf));
    const revision=createHash('sha256').update(JSON.stringify([p.project??null,p.status??null,visible])).digest('hex');
    const snapshot=p.snapshot??{at:now,revision};
    if(!snapshot||typeof snapshot!=='object'||!Number.isSafeInteger(snapshot.at)||snapshot.at<0||snapshot.at>now||snapshot.revision!==revision||p.after>0&&(!p.snapshot||p.asOf===undefined))throw Error('Inbox changed or invalid cursor; restart pagination');
    for(const row of visible)if(['PENDING_REVIEW','SEEN'].includes(row.status)&&Date.parse(row.expiresAt)<=snapshot.at)row.status='EXPIRED';
    const filtered=visible.map((r,i)=>({...r,sequence:i+1})).filter(r=>r.sequence>(p.after??0)&&(!p.project||r.project===p.project)&&(!p.status||r.status===p.status));
    const page=filtered.slice(0,p.limit??100);
    return {requests:page,next:filtered.length>page.length?page.at(-1).sequence:null,asOf,snapshot,unresolved:unresolvedRequests(visible),authorization:false};
  });
}
