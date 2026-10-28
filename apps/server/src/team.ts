import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { connect, modelRef } from './opencode.ts';
import { roles, columns } from '../../../packages/shared/src/index.ts';
import { proposalSchema, approvalSchema, surveyPrompt } from './planning.ts';

const exec = promisify(execFile);
const text = z.string().trim().min(1).max(30000);
export const taskSchema = z.object({projectID:z.string(),title:text,assignee:z.enum(roles),priority:z.enum(['low','medium','high']).default('medium'),dependencies:z.array(z.string()).max(50).default([]),criteria:text});
export const messageSchema = z.object({projectID:z.string(),receiver:z.enum([...roles,'team']),body:text,idempotencyKey:z.string().min(1).max(200)});
export class Team {
  connection: any = {status:'disconnected'};
  running = new Set<string>();
  checkingHealth = false;
  stopping = false;
  changed = () => {};
  constructor(public store: Store, public dataDir: string, public port: number) {
    // ponytail: ambiguous in-flight delivery never auto-replays; inspect session then retry explicitly.
    for (const m of store.all('messages').filter(m=>m.status==='processing')) store.patch('messages',m.id,{status:'uncertain',error:'Server restarted; inspect session before retry'});
    for (const a of store.all('agents').filter(a=>a.status==='working')) store.patch('agents',a.id,{status:'unknown',error:'Server restarted; verify OpenCode session state'});
  }
  log(kind: string,data: any,projectID?: string) { this.store.add('logs',{kind,data,projectID}); this.changed(); }
  async health() {
    if(this.checkingHealth || this.stopping)return;
    this.checkingHealth=true;
    try {
      const {info,client} = await connect(); this.connection={status:'connected',version:info.version};
      const active=await client.session.active();
      for(const a of this.store.all('agents').filter(a=>a.sessionID)) {
        try {
          const pending=await client.permission.list({sessionID:a.sessionID});
          await client.session.get({sessionID:a.sessionID});
          const status=pending.length?'blocked':active[a.sessionID]?'working':'idle';
          this.store.patch('agents',a.id,{status,error:pending.length?'Chờ human approval trong OpenCode':null,pendingPermission:pending,lastCheckedAt:new Date().toISOString()});
        }catch(e){this.store.patch('agents',a.id,{status:'unknown',error:String(e)});}
      }
    } catch(e) { this.connection={status:'error',error:String(e)}; }
    finally {this.checkingHealth=false;}
    this.changed();
  }
  async project(input: unknown) {
    const p=z.object({name:text,path:text}).parse(input);
    const path=await realpath(p.path);
    const root=(await exec('git',['-C',path,'rev-parse','--show-toplevel'])).stdout.trim();
    if(path!==await realpath(root)) throw new Error('Chọn Git project root; cần ít nhất một commit để tạo worktree');
    await exec('git',['-C',path,'rev-parse','HEAD']);
    if(this.store.all('projects').some(p=>p.path===path)) throw new Error('Project đã tồn tại');
    const project=this.store.add('projects',{...p,path,paused:false,onboarding:'surveying'});
    this.send({projectID:project.id,receiver:'admin',body:surveyPrompt,idempotencyKey:`survey:${project.id}`},'system');
    this.changed(); return project;
  }
  submitProposal(projectID:string,input:unknown,actor:string) {
    if(actor!=='admin')throw new Error('Chỉ Admin được gửi đề xuất');
    const p=this.store.get('projects',projectID);
    if(p.onboarding==='approved')throw new Error('Project đã được duyệt; không thay phạm vi âm thầm');
    const proposal=proposalSchema.parse(input);
    for(const member of proposal.members)if(member.model)modelRef(member.model);
    const version=(p.proposal?.version??0)+1;
    const result=this.store.patch('projects',projectID,{onboarding:'awaiting_approval',proposal:{...proposal,version,createdAt:new Date().toISOString()}});
    this.log('project.proposal',{version},projectID);return result.proposal;
  }
  approveProject(projectID:string,input:unknown) {
    const approval=approvalSchema.parse(input);const p=this.store.get('projects',projectID);
    if(p.onboarding!=='awaiting_approval'||!p.proposal||p.proposal.version!==approval.version)throw new Error('Đề xuất đã thay đổi hoặc chưa sẵn sàng; tải lại trước khi duyệt');
    if(approval.maxParallel>p.proposal.members.length)throw new Error('Parallel vượt số coding role được duyệt');
    const result=this.store.patch('projects',projectID,{onboarding:'approved',approval:{...approval,members:p.proposal.members,approvedAt:new Date().toISOString()}});
    this.send({projectID,receiver:'admin',body:`Human approved scope and team. Goal: ${approval.goal}\nBudget acknowledgement (not enforced money cap): ${approval.budgetNote}\nApproved roles: ${JSON.stringify(p.proposal.members)}; max parallel coding sessions ${approval.maxParallel}. Create backlog with dependencies and acceptance criteria. Use team_execute_task to activate independent tasks. Do not execute dependent tasks before human confirms integration. Never exceed scope.`,idempotencyKey:`approval:${projectID}:${approval.version}`},'system');
    this.log('project.approved',{version:approval.version,maxParallel:approval.maxParallel},projectID);return result;
  }
  assertRoleApproved(projectID:string,role:string) {
    const p=this.store.get('projects',projectID);
    // ponytail: legacy projects retain prior behavior; onboarding applies to newly added projects.
    if(!p.onboarding||role==='admin')return;
    if(p.onboarding!=='approved')throw new Error('Chờ human duyệt mục tiêu, đội và ngân sách trước khi chạy coding agent');
    if(!p.approval.members.some((m:any)=>m.role===role))throw new Error('Role chưa nằm trong đội được human duyệt');
  }
  task(input: unknown, actor='user') {
    const t=taskSchema.parse(input); this.store.get('projects',t.projectID);
    for (const id of t.dependencies) if(this.store.get('tasks',id).projectID!==t.projectID) throw new Error('Dependency khác project');
    const task=this.store.add('tasks',{...t,status:'Todo',createdBy:actor,approved:false,evidence:''}); this.changed(); return task;
  }
  updateTask(id: string,input: unknown,actor: string) {
    const p=z.object({status:z.enum(columns),evidence:z.string().max(30000).default('')}).parse(input);
    const t=this.store.get('tasks',id);
    if(p.status==='Done' && (actor!=='qa' || !p.evidence.trim())) throw new Error('Done cần QA và bằng chứng kiểm thử');
    if(p.status==='Done' && !t.verification)throw new Error('Cần team_verify_task từ shell tool QA exit 0 trước Done');
    if(p.status==='In Progress' && t.dependencies.some((id:string)=>this.store.get('tasks',id).status!=='Done')) throw new Error('Dependency chưa Done');
    if(!['user','admin','qa',t.assignee].includes(actor)) throw new Error('Không có quyền cập nhật task');
    const result=this.store.patch('tasks',id,{...p,...(p.status!=='Done'?{approved:false,verification:null,integratedAt:null}:{})}); this.changed(); return result;
  }
  executeTask(id:string,actor:string) {
    const t=this.store.get('tasks',id);
    const project=this.store.get('projects',t.projectID);
    if(project.onboarding&&project.onboarding!=='approved')throw new Error('Chờ human duyệt project trước khi thực hiện task');
    this.assertRoleApproved(t.projectID,t.assignee);
    if(!['user','admin','qa'].includes(actor))throw new Error('Chỉ human, Admin hoặc QA được giao task');
    if(!['Todo','Backlog','Blocked'].includes(t.status))throw new Error('Task phải ở Backlog, Todo hoặc Blocked');
    if(t.dependencies.some((id:string)=>!this.store.get('tasks',id).integratedAt))throw new Error('Dependency chưa được human xác nhận tích hợp');
    const previous=t.executionMessageID&&this.store.get('messages',t.executionMessageID);
    if(previous&&['queued','processing','uncertain'].includes(previous.status))throw new Error('Task đã có lượt chạy hoặc chưa xác định kết quả');
    const attempt=(t.executionAttempt??0)+1;
    if(attempt>3)throw new Error('Task vượt giới hạn 3 lượt chạy');
    const message=this.send({projectID:t.projectID,receiver:t.assignee,body:`Execute task ${t.id}: ${t.title}\nAcceptance criteria: ${t.criteria}\nSet In Progress using team_update_task. Make real changes in your own worktree. Request QA review with exact paths and test commands. Report blocker instead of inventing completion.`,idempotencyKey:`task:${t.id}:attempt:${attempt}`},actor);
    this.store.patch('tasks',id,{status:'Todo',executionMessageID:message.id,executionAttempt:attempt,executionStatus:'queued'});
    this.log('task.dispatched',{taskID:id,messageID:message.id,actor},t.projectID);return message;
  }
  send(input: unknown,sender='user',parent?: any) {
    const m=messageSchema.parse(input); this.store.get('projects',m.projectID);
    this.assertRoleApproved(m.projectID,m.receiver==='team'?'admin':m.receiver);
    const old=this.store.all('messages').find(v=>v.idempotencyKey===m.idempotencyKey);
    if(old) { if(old.projectID!==m.projectID || old.sender!==sender || old.body!==m.body || old.receiver!==m.receiver) throw new Error('Idempotency key conflict'); return old; }
    const hops=parent ? parent.hops+1:0;
    if(hops>6) throw new Error('Conversation hop limit 6; cần người dùng mở lượt mới');
    const result=this.store.add('messages',{...m,sender,status:'queued',attempts:0,hops,threadID:parent?.threadID??randomUUID(),parentID:parent?.id});
    this.changed(); return result;
  }
  async agent(projectID: string,role: string) {
    this.assertRoleApproved(projectID,role);
    const old=this.store.all('agents').find(a=>a.projectID===projectID && a.role===role);
    if(old?.sessionID) return old;
    const p=this.store.get('projects',projectID);
    const a=old??this.store.add('agents',{projectID,role,status:'provisioning',model:'',capability:randomBytes(32).toString('hex')});
    const directory=resolve(this.dataDir,'worktrees',a.id);
    await mkdir(resolve(this.dataDir,'worktrees'),{recursive:true});
    try { await access(directory); } catch { await exec('git',['-C',p.path,'worktree','add','-b',`ai-team/${a.id}`,directory,'HEAD']); }
    await mkdir(join(directory,'.opencode'),{recursive:true});
    const config=join(directory,'.opencode','opencode.jsonc');
    if(!a.configManaged) {
      try { await access(config); throw new Error(`Không ghi đè config có sẵn: ${config}; cần tích hợp MCP thủ công trước khi retry`); } catch(e:any) { if(e.code!=='ENOENT') throw e; }
      await writeFile(config,JSON.stringify({$schema:'https://opencode.ai/config.json',mcp:{servers:{team:{type:'remote',url:`http://127.0.0.1:${this.port}/mcp/${a.id}`,oauth:false,headers:{Authorization:`Bearer ${a.capability}`}}}}}),{mode:0o600,flag:'wx'});
      this.store.patch('agents',a.id,{configManaged:true,directory});
    }
    const {client}=await connect();
    const permissions=[{action:'*',resource:'*',effect:'ask' as const},...['read','glob','grep','execute','team_*'].map(action=>({action,resource:'*',effect:'allow' as const})),{action:'external_directory',resource:'*',effect:'ask' as const},{action:'edit',resource:'*',effect:role==='admin'?'deny' as const:'allow' as const},{action:'shell',resource:'*',effect:'ask' as const},{action:'read',resource:'.opencode/opencode.jsonc',effect:'deny' as const}];
    if(role==='admin'&&p.onboarding&&p.onboarding!=='approved')permissions.push({action:'shell',resource:'*',effect:'deny'},{action:'external_directory',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'deny'});
    const chosen=p.approval?.members.find((m:any)=>m.role===role)?.model;
    const session=await client.session.create({title:`AI Team ${p.name} / ${role}`,location:{directory},permissions,...(chosen?{model:modelRef(chosen)}:{})});
    const selected=session.model?`${session.model.providerID}/${session.model.id}`:'';
    return this.store.patch('agents',a.id,{directory,sessionID:session.id,status:'idle',permissions,model:selected});
  }
  async tick() {
    if(this.stopping||this.connection.status!=='connected'||this.checkingHealth)return;
    for(const m of this.store.all('messages').filter(m=>m.status==='queued')) {
      const role=m.receiver==='team'?'admin':m.receiver;
      const key=`${m.projectID}:${role}`;
      const existing=this.store.all('agents').find(a=>a.projectID===m.projectID&&a.role===role);
      const p=this.store.get('projects',m.projectID);
      if(role!=='admin'&&p.approval) {
        const activeRoles=new Set(this.store.all('agents').filter(a=>a.projectID===m.projectID&&a.role!=='admin'&&['working','blocked'].includes(a.status)).map(a=>a.role));
        for(const key of this.running)if(key.startsWith(`${m.projectID}:`)&&!key.endsWith(':admin'))activeRoles.add(key.split(':')[1]);
        if(activeRoles.size>=p.approval.maxParallel)continue;
      }
      if(this.running.has(key)||['working','blocked','unknown'].includes(existing?.status)||this.store.get('projects',m.projectID).paused) continue;
      this.running.add(key);
      this.deliver(m,role).catch(e=>this.log('dispatcher.error',String(e),m.projectID)).finally(()=>this.running.delete(key));
    }
  }
  async deliver(m:any,role:string) {
    this.store.patch('messages',m.id,{status:'processing',attempts:m.attempts+1}); this.changed();
    let agent:any;
    try {
      agent=await this.agent(m.projectID,role);
      this.store.patch('agents',agent.id,{status:'working',currentMessageID:m.id,error:null});
      const {client}=await connect();
      if((await client.session.active())[agent.sessionID])throw new Error('Session đang chạy từ client khác; không gửi chồng');
      const prompt=`You are ${role} of a real software team. Your private worktree: ${agent.directory}. Project canonical checkout: ${this.store.get('projects',m.projectID).path}. Never modify another checkout. Never push, deploy, modify credentials, or destroy data. Ask human for shell permission. Use team MCP tools to coordinate; sender identity is bound to your session. Task completion requires QA test evidence, then human integration approval. Do not claim success without evidence. Admin: inspect code, create concrete backlog with team_update_task (action=create), priorities, dependencies, criteria; delegate via team_send_message; resolve blockers and request QA review. QA: inspect actual diffs, run real tests with permission; create bug tasks and send repair requests. All roles: use team_get_inbox and project context. Cross-worktree code is not integrated until human approval; never silently merge.\nMessage ID ${m.id}, from ${m.sender}, thread ${m.threadID}, hops ${m.hops}/6:\n${m.body}\nTasks/context: ${JSON.stringify(this.store.all('tasks').filter(t=>t.projectID===m.projectID))}`;
      const project=this.store.get('projects',m.projectID);
      const survey=project.onboarding&&project.onboarding!=='approved';
      const instructions=survey?`${surveyPrompt}\nHuman message/context:\n${m.body}`:prompt;
      const inbox=await client.session.prompt({sessionID:agent.sessionID,text:instructions});
      this.store.patch('messages',m.id,{inboxID:inbox.id});
      await client.session.wait({sessionID:agent.sessionID},{signal:AbortSignal.timeout(15*60*1000)});
      const history=await client.message.list({sessionID:agent.sessionID,limit:100,order:'desc'});
      const replies=history.data.filter(v=>v.type==='assistant'&&v.time.created>=Date.parse(m.createdAt));
      for(const reply of replies.reverse()) {
        if(reply.type!=='assistant') continue;
        const key=`opencode:${reply.id}`;
        const body=reply.content.filter(v=>v.type==='text').map(v=>v.text).join('\n');
        if(body&&!this.store.all('messages').some(v=>v.idempotencyKey===key)) this.store.add('messages',{projectID:m.projectID,sender:role,receiver:m.sender,body,status:reply.error?'error':'delivered',idempotencyKey:key,threadID:m.threadID,hops:m.hops,sessionID:agent.sessionID,error:reply.error});
        this.log('session.output',reply,m.projectID);
      }
      if(replies.some(r=>r.type==='assistant'&&r.error)) throw new Error('OpenCode assistant error; xem execution logs');
      this.store.patch('messages',m.id,{status:'delivered'});
      const task=this.store.all('tasks').find(t=>t.executionMessageID===m.id);
      if(task)this.store.patch('tasks',task.id,{executionStatus:'responded'});
      this.store.patch('agents',agent.id,{status:'idle',currentMessageID:null});
    } catch(e) {
      this.store.patch('messages',m.id,{status:'uncertain',error:String(e)});
      const task=this.store.all('tasks').find(t=>t.executionMessageID===m.id);
      if(task)this.store.patch('tasks',task.id,{executionStatus:'uncertain'});
      if(agent) this.store.patch('agents',agent.id,{status:'blocked',error:String(e)});
      this.log('delivery.error',String(e),m.projectID);
    } finally { this.changed(); }
  }
  async setModel(id:string,model:string) {
    const a=this.store.get('agents',id); if(a.status==='working') throw new Error('Agent đang chạy');
    const {client}=await connect(); await client.session.switchModel({sessionID:a.sessionID,model:modelRef(model)});
    this.store.patch('agents',id,{model});this.changed();
  }
  async diff(projectID:string) {
    const agents=this.store.all('agents').filter(a=>a.projectID===projectID&&a.directory);
    const parts=await Promise.all(agents.map(async a=>`${a.role} ${a.directory}\n${(await exec('git',['-C',a.directory,'status','--short'])).stdout}\n${(await exec('git',['-C',a.directory,'diff','HEAD'],{maxBuffer:4*1024*1024})).stdout}`));
    return parts.join('\n\n');
  }
}
