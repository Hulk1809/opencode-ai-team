// ponytail: RPC lacks an authenticated Owner; enable mutation only with host-backed identity.
export const MODEL_SWITCH_BLOCKED='OpenCode 2.2.5 RPC chưa xác thực Owner. Mở session và dùng model selector native; panel chưa được phép đổi model.';
export const OWNER_MODEL_CONTEXT_BLOCKED='BLOCKED · OpenCode 2.2.5 chưa cung cấp authenticated Owner context cho selector của plugin. Không mở approval dialog thay thế, không đổi session model. Native composer chỉ là draft, chưa chứng minh persistence/synchronization.';
export function publicModels(value){
  const rows=Array.isArray(value)?value:value?.data;
  if(!Array.isArray(rows))throw Error('PILOT_MODEL_CATALOG_INVALID');
  return rows.filter(m=>m.enabled===true&&(m.type==null||m.type==='chat')&&m.status!=='deprecated').map(m=>({
    providerID:m.providerID,id:m.id,name:m.name,status:m.status,
    variants:(m.variants??[]).map(v=>v.id),
    cost:(m.cost??[]).filter(c=>Number.isFinite(c.input)&&c.input>=0&&Number.isFinite(c.output)&&c.output>=0).map(c=>({input:c.input,output:c.output,...(c.tier?.type==='context'&&Number.isFinite(c.tier.size)?{contextTier:c.tier.size}:{})})),
    context:Number.isInteger(m.limit?.context)?m.limit.context:null,
    output:Number.isInteger(m.limit?.output)?m.limit.output:null
  }));
}
export function memberModel(session,catalog){
  const model=session.model;
  const selection=model?{providerID:model.providerID,id:model.id,variant:model.variant??null}:null;
  const available=!!selection&&catalog.some(m=>m.providerID===selection.providerID&&m.id===selection.id&&(selection.variant===null||m.variants.includes(selection.variant)));
  return {selection,available,reason:!selection?'Native session chưa có model được ghim.':!available?'Provider/model/variant không khả dụng trong catalog.':null};
}
