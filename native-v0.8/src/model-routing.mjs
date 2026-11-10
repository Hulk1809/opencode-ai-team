import {routingAdmissionBlocked} from './peer-presentation.mjs';
export const DEFAULT_MODELS=Object.freeze({
  admin:Object.freeze({providerID:'taile',id:'cx/gpt-6.1-sol',variant:'medium'}),
  worker:Object.freeze({providerID:'taile',id:'ag/gemini-3.8-flash-medium',variant:'medium'})
});
const simple=new Set(['read','small-edit','format','documentation','basic-test-fix']);
const complex=new Set(['architecture','multi-module-debug','security-review','complex-review','planning','integration']);
export const sameModel=(a,b)=>!!a&&!!b&&a.providerID===b.providerID&&a.id===b.id&&(a.variant??null)===(b.variant??null);
export function routingKey({projectID,teamID,sessionID}){
  if(![projectID,teamID,sessionID].every(x=>typeof x==='string'&&x.length>0))throw Error('ROUTING_IDENTITY_REQUIRED');
  return JSON.stringify([projectID,teamID,sessionID]);
}
export function routeModel({team,member,task,catalog,policy}){
  const key=routingKey({projectID:team?.projectID,teamID:team?.teamID,sessionID:member?.sessionID});
  if(!team.members?.some(m=>m.sessionID===member?.sessionID&&m.role===member?.role&&m.directory===member?.directory)||team.mode!=='peer'&&!['admin','worker-1','worker-2'].includes(member.role))throw Error('ROUTING_MEMBER_MISMATCH');
  if(policy?.projectID!==team.projectID||policy?.teamID!==team.teamID||!['auto','smart','manual'].includes(policy.mode))throw Error('ROUTING_POLICY_MISMATCH');
  if(!Array.isArray(catalog)||!Array.isArray(policy.allowed)||['maxInputPrice','maxOutputPrice'].some(k=>policy[k]!=null&&(!Number.isFinite(policy[k])||policy[k]<0)))throw Error('ROUTING_CONSTRAINT_INVALID');
  if(!task||typeof task.id!=='string'||!task.id||task.sessionID!==member.sessionID||task.projectID!==team.projectID||task.teamID!==team.teamID)throw Error('ROUTING_TASK_MISMATCH');
  const complexity=complex.has(task.type)?'complex':simple.has(task.type)?'simple':'unknown';
  let selected=policy.defaults?.[member.role]??DEFAULT_MODELS[member.role==='admin'?'admin':'worker'];
  let reason=complexity==='unknown'?'Độ phức tạp chưa rõ; giữ mặc định.':'Giữ model mặc định; không suy ra giá rẻ từ tên model.';
  let approvalRequired=false;
  const manual=policy.manual?.[member.sessionID];
  if(manual){selected=manual;reason='Lựa chọn thủ công ưu tiên; Smart Routing không ghi đè.';}
  else if(policy.mode==='manual'){approvalRequired=true;reason='Manual chưa có lựa chọn; cần Owner chọn model.';}
  else if(policy.mode==='smart'&&complexity==='complex'&&member.role!=='admin'){
    if(policy.allowWorkerUpgrade===true){selected=DEFAULT_MODELS.admin;reason='Task phức tạp; policy đề xuất Sol cho Worker.';}
    else{approvalRequired=true;reason='Task phức tạp; giữ Flash, cần Owner duyệt nâng model.';}
  }else if(member.role==='admin')reason='Admin giữ Sol/mặc định được cấu hình; không tự downgrade.';
  if(member.role==='admin'&&!manual&&!sameModel(selected,DEFAULT_MODELS.admin)&&policy.allowAdminDowngrade!==true)throw Error('ROUTING_ADMIN_DOWNGRADE_NOT_APPROVED');
  if(!policy.allowed?.some(m=>sameModel(m,selected)))throw Error('ROUTING_MODEL_NOT_ALLOWED');
  const model=catalog.find(m=>m.providerID===selected.providerID&&m.id===selected.id);
  if(!model||selected.variant!=null&&!model.variants.includes(selected.variant))throw Error('ROUTING_MODEL_UNAVAILABLE: Owner cần chọn model khác; không fallback.');
  const priceKnown=!!model.cost?.length;
  if(policy.maxInputPrice!=null||policy.maxOutputPrice!=null){
    if(!priceKnown||model.cost.some(c=>policy.maxInputPrice!=null&&c.input>policy.maxInputPrice||policy.maxOutputPrice!=null&&c.output>policy.maxOutputPrice))approvalRequired=true;
  }
  // ponytail: GUI preferences are proposals, never execution grants; add host-verified policy at execution boundary.
  return {id:JSON.stringify([key,task.id,task.type,policy.mode,selected,reason]),binding:{projectID:team.projectID,teamID:team.teamID,sessionID:member.sessionID,taskID:task.id},selected:{...selected},complexity,reason,approvalRequired,priceKnown,unattendedAllowed:false,status:'Chưa áp dụng'};
}

export async function selectCurrentComposer(ctx,team,member,selection,catalog){
  const current=ctx.sessions.current(),screen=ctx.screen.current();
  if(!current||!screen||current.id!==member.sessionID||current.directory!==member.directory||!team.members.some(m=>m.sessionID===member.sessionID&&m.directory===member.directory))throw Error('ROUTING_OPEN_MEMBER_SESSION_FIRST');
  const available=catalog.find(m=>m.providerID===selection.providerID&&m.id===selection.id);
  if(!available||selection.variant!=null&&!available.variants.includes(selection.variant))throw Error('ROUTING_MODEL_UNAVAILABLE');
  const session=await current.server.client.session.get({sessionID:current.id});
  if(ctx.sessions.current()!==current||ctx.screen.current()!==screen||session.id!==member.sessionID||session.projectID!==team.projectID||session.location.directory!==member.directory||session.location.workspaceID!==member.workspaceID||session.agent!==member.agent)throw Error('ROUTING_NATIVE_BINDING_MISMATCH');
   const active=await current.server.client.session.active();
   if(!active||typeof active!=='object'||Array.isArray(active))throw Error('ROUTING_SESSION_BUSY_OR_UNKNOWN');
   if(ctx.sessions.current()!==current||ctx.screen.current()!==screen)throw Error('ROUTING_NATIVE_BINDING_MISMATCH');
   // time.idle is the last terminal transition, not current activity; new sessions have none.
    if(Object.hasOwn(active,member.sessionID)||routingAdmissionBlocked(team,member))throw Error('ROUTING_SESSION_BUSY_OR_UNKNOWN');
  // Current composer only: supported native picker semantics, not arbitrary-session switchModel or a prompt submission.
  if(!screen.composer.setModel({providerID:selection.providerID,modelID:selection.id,...(selection.variant==null?{}:{variant:selection.variant})}))throw Error('ROUTING_COMPOSER_REJECTED');
  const actual=screen.composer.model();
  if(!sameModel({...selection,variant:selection.variant??'default'},actual&&{providerID:actual.providerID,id:actual.modelID,variant:actual.variant??'default'}))throw Error('ROUTING_COMPOSER_READBACK_MISMATCH');
  return actual;
}
