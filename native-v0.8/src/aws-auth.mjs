import {randomUUID} from 'node:crypto';
import {redact} from './safety.mjs';
// ponytail: broker not deployed; metadata workflow only. Add protected handoff after isolation acceptance.
export async function awsAuth(room,directory,role,action,p){
  return room.exclusive(directory,async()=>{
    const team=await room.read(directory);
    if(action==='aws_propose'){
      if(role!=='devops')throw Error('DevOps đề xuất AWS auth');
      const fields=['account','environment','purpose','scope','profile','method'];
      if(Object.keys(p).some(k=>!fields.includes(k))||fields.some(k=>typeof p[k]!=='string'||!p[k].trim()||p[k].length>500)||!/^\d{12}$/.test(p.account)||!['sso-device-code','login-remote'].includes(p.method)||! /^(?!-)[A-Za-z0-9_-]{1,128}$/.test(p.profile)||fields.some(k=>redact(p[k])!==p[k]||/https?:\/\//i.test(p[k])))throw Error('Chỉ metadata AWS; không URL, code hoặc secrets');
      team.awsAuth??=[];
      const row={id:randomUUID(),...p,project:directory,status:'PROPOSED',broker:'NOT_DEPLOYED',cliSupport:'UNVERIFIED',createdAt:new Date().toISOString()};
      team.awsAuth.push(row);await room.write(directory,team);return row;
    }
    const row=team.awsAuth?.find(x=>x.id===p.requestID);if(!row)throw Error('AWS request không tồn tại trong project');
    if(action==='aws_request'){
      if(role!=='admin'||row.status!=='PROPOSED')throw Error('Admin gửi đề xuất DevOps tới Owner');
      row.status='OWNER_REVIEW';
    }else{
      if(role!=='owner'||row.status!=='OWNER_REVIEW'||p.confirm!==true)throw Error('Owner xác nhận metadata');
      // GUI intent is not authenticated broker approval. Never issue a credential or start CLI.
      row.status='BLOCKED';row.reason='BROKER_NOT_DEPLOYED';row.ownerIntentAt=new Date().toISOString();row.approvalValid=false;
    }
    await room.write(directory,team);return row;
  });
}
