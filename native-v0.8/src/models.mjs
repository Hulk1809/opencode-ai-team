import { ROLES } from './room.mjs';
export const ADMIN_INSTRUCTIONS='Bạn là Tech Lead, Project Manager và Software Architect của AI Team. Đọc yêu cầu/tài liệu thật, xem repository và kiến trúc trong phạm vi quyền. Lập backlog chi tiết với dependencies, priority, acceptance criteria; giao đúng Frontend, Backend, DevOps, QA bằng team tools. Review artifact và phản hồi thật, yêu cầu sửa khi cần, theo dõi tiến độ/blockers, yêu cầu QA kiểm thử, tổng hợp tài liệu/kết quả cho Owner. Ưu tiên lập kế hoạch, điều phối, review và quyết định, không tự code mọi phần. Không đánh dấu hoàn thành khi thiếu bằng chứng; không giả lập kết quả hoặc vượt quyền. task.completed là control event để review artifacts/evidence, không giao lại coding đã done. task.blocked/queue.stalled cần đối soát evidence; dùng send_message kind=control kèm taskID rõ ràng cho correction/unblock/review. Chỉ update_task working sau khi ghi note bằng chứng blocker đã giải quyết, giữ dependency và permissions. Share artifact fileIDs qua share_file cho role cần tích hợp, không yêu cầu Owner copy file khi role đã có quyền read_file và ghi file tích hợp. Chỉ xin Owner khi cần quyền/quyết định ngoài phạm vi hoặc merge/push/deploy.';
export const CONTROL_REVIEW_INSTRUCTIONS='Review artifacts/evidence trong Admin; không gửi ACK, review-approved hoặc yêu cầu xác nhận trùng tới worker có task done. Chỉ request_review hoặc reopen khi có yêu cầu review/correction thật và note evidence; không đổi status chỉ để gửi ACK. Control tới worker phải có taskID rõ ràng; needs_review giữ nguyên để đối soát, không tự replay.';
const rows=x=>Array.isArray(x)?x:x?.data??[];
export class TeamModels {
  constructor(ctx,room){this.ctx=ctx;this.room=room;}
  async catalog(){return {models:rows(await this.ctx.model.list()).filter(m=>m.enabled!==false).map(m=>({providerID:m.providerID,id:m.id,name:m.name,variants:(m.variants??[]).map(v=>v.id)}))};}
  async change(directory,{role,providerID,modelID,variant,saveDefault=false}) {
    if(!ROLES.includes(role)||typeof saveDefault!=='boolean')throw new Error('Role hoặc default không hợp lệ');
    const model=(await this.catalog()).models.find(m=>m.providerID===providerID&&m.id===modelID);
    if(!model||variant!==undefined&&(typeof variant!=='string'||!model.variants.includes(variant)))throw new Error('Model hoặc variant không khả dụng; không tự fallback');
    return this.room.exclusive(directory,async()=>{
      const team=await this.room.read(directory),member=team?.members?.[role];
      if(!member)throw new Error('Session không thuộc team');
      const session=await this.ctx.session.get({sessionID:member.sessionID});
      const transcript=rows(await this.ctx.session.context({sessionID:member.sessionID}));
      const last=transcript.findLast(m=>!['agent-switched','model-switched'].includes(m.type));
      if(team.messages.some(m=>m.to===role&&['queued','admitted','uncertain','waiting'].includes(m.status))||(last&&last.type!=='idle'))throw new Error('Agent đang bận; đợi hoàn tất rồi đổi model');
      const selection={providerID,id:modelID,...(variant===undefined?{}:{variant})};
      await this.ctx.session.switchModel({sessionID:member.sessionID,model:selection});
      const actual=await this.ctx.session.get({sessionID:member.sessionID});
      if(actual.model?.providerID!==providerID||actual.model?.id!==modelID||actual.model?.variant!==variant)throw new Error('Server chưa xác nhận lựa chọn model; không ghi default');
      const setting={agentID:role,providerID,modelID,variant:variant??null,sessionID:session.id,changedAt:new Date().toISOString()};
      member.modelSetting=setting;
      if(saveDefault){team.modelDefaults??={};team.modelDefaults[role]=selection;}
      team.modelEvents??=[];team.modelEvents.push(setting);
      await this.room.write(directory,team);
      return {setting,selected:actual.model};
    });
  }
}
