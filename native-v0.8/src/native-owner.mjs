import {redact} from './safety.mjs';
export function stableRows(previous,next) {
  const known=new Map(previous.map(row=>[row.id,row]));
  const rows=next.map(row=>{const old=known.get(row.id);return old&&JSON.stringify(old)===JSON.stringify(row)?old:row});
  return rows.length===previous.length&&rows.every((row,i)=>row===previous[i])?previous:rows;
}
// GUI-only: current() must return the host MountedSession, never RPC input.
export async function ownerAdminTarget(current,contract) {
  const host=current(),server=host?.server,client=server?.client;
  if(!host?.project?.id||!host.location||!server.connected||!server.compatible)throw Error('OWNER_HOST_UNAVAILABLE');
  const directory=host.directory;
  const valid=()=>current()===host&&server.client===client&&server.connected&&host.location?.directory===directory;
  const team=await client.rpc(contract).snapshot({directory},{location:host.location,signal:AbortSignal.timeout(15000)});
  const admin=team?.members?.admin;
  if(!valid()||team?.status!=='ready'||team.directory!==directory||admin?.role!=='admin'||!admin.sessionID)throw Error('OWNER_REGISTRY_MISMATCH');
  const session=await client.session.get({sessionID:admin.sessionID},{signal:AbortSignal.timeout(15000)});
  if(!valid()||session.id!==admin.sessionID||session.agent!=='admin'||session.projectID!==host.project.id||session.metadata?.teamDirectory!==directory||session.location?.directory!==(admin.directory??directory)||session.location?.workspaceID!==host.location.workspaceID)throw Error('OWNER_ADMIN_BINDING_MISMATCH');
  return {host,client,session,valid};
}

export async function ownerAdminSend(current,contract,attempt) {
  if(typeof attempt?.text!=='string'||!attempt.text.trim()||attempt.text.length>10000||!/^msg_[a-f0-9]{32}$/.test(attempt.id))throw Error('OWNER_MESSAGE_INVALID');
  const target=await ownerAdminTarget(current,contract);
  // A failed admission must retain this target as well as its ID for explicit retry.
  const binding=JSON.stringify([target.host.server.id,target.host.project.id,target.host.directory,target.session.id,target.session.location]);
  if(attempt.binding&&attempt.binding!==binding)throw Error('OWNER_RETRY_TARGET_CHANGED');
  attempt.binding=binding;
  if(!target.valid())throw Error('OWNER_HOST_CHANGED');
  return target.client.session.prompt({sessionID:target.session.id,id:attempt.id,text:attempt.text,delivery:'queue',metadata:{aiTeamOwnerChat:1}},{signal:AbortSignal.timeout(15000)});
}

// This metadata marks presentation origin only; never an authorization credential.
export function ownerTranscript(history,inbox) {
  const rows=new Map();let owner,unanswered=false,ambiguous=false;
  for(const message of new Map(history.map(m=>[m.id,m])).values()){
    if(message.type==='user'){ambiguous=unanswered;unanswered=true;}
    if(message.type==='user'||message.type==='synthetic'||message.type==='shell'||message.type==='compaction')owner=undefined;
    if(message.type==='user'&&message.metadata?.aiTeamOwnerChat===1){
      owner=message.id;
      rows.set(message.id,{id:message.id,promptID:message.id,from:'owner',to:'admin',text:redact(message.text),status:'admitted',at:new Date(message.time.created).toISOString(),native:true});
    }else if(message.type==='assistant'&&message.agent==='admin'&&owner){
      const status=message.error||message.finish==='error'?'failed':message.time.completed?(message.finish==='stop'?'completed':'unknown'):'running';
      const tools=message.content.filter(p=>p.type==='tool').map(p=>({id:p.id,name:p.name,status:p.state.status,executed:p.executed===true,result:redact((p.state.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,12000)),error:p.state.error?redact(JSON.stringify(p.state.error).slice(0,2000)):undefined}));
      rows.set(message.id,{id:message.id,...(!ambiguous?{promptID:owner}:{}),correlation:ambiguous?'ambiguous-inputs':'chronological-not-parent-proof',from:'admin',to:'owner',text:redact(message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n')),tools,status,at:new Date(message.time.created).toISOString(),native:true});
    }
    if(message.type==='assistant'&&message.time.completed&&message.finish==='stop')unanswered=false;
  }
  for(const item of inbox)if(item.type==='user'&&item.payload.metadata?.aiTeamOwnerChat===1&&!rows.has(item.id))rows.set(item.id,{id:item.id,promptID:item.id,from:'owner',to:'admin',text:redact(item.payload.text),status:item.delivery==='queue'?'queued':'unknown',at:new Date(item.time.created).toISOString(),native:true});
  return [...rows.values()];
}

export async function ownerAdminHistory(current,contract) {
  const target=await ownerAdminTarget(current,contract),history=[],cursors=new Set();
  let cursor;
  do{
    const page=await target.client.message.list({sessionID:target.session.id,order:'asc',limit:100,...(cursor?{cursor}:{})},{signal:AbortSignal.timeout(15000)});
    if(!target.valid())throw Error('OWNER_HOST_CHANGED');
    history.push(...page.data);
    cursor=page.cursor.next;
    if(cursor&&cursors.has(cursor))throw Error('OWNER_HISTORY_CURSOR_REPEATED');
    if(cursor)cursors.add(cursor);
  }while(cursor);
  const inbox=await target.client.session.inbox.list({sessionID:target.session.id},{signal:AbortSignal.timeout(15000)});
  if(!target.valid())throw Error('OWNER_HOST_CHANGED');
  return ownerTranscript(history,inbox);
}
