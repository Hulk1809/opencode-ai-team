import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { connect, modelRef } from './opencode.ts';
import { roles, columns } from '../../../packages/shared/src/index.ts';

const exec = promisify(execFile);
const text = z.string().trim().min(1).max(30000);
export const taskSchema = z.object({projectID:z.string(),title:text,assignee:z.enum(roles),priority:z.enum(['low','medium','high']).default('medium'),dependencies:z.array(z.string()).max(50).default([]),criteria:text});
export const messageSchema = z.object({projectID:z.string(),receiver:z.enum([...roles,'team']),body:text,idempotencyKey:z.string().min(1).max(200)});
export class Team {
  connection: any = {status:'disconnected'};
  running = new Set<string>();
  changed = () => {};
  constructor(public store: Store, public dataDir: string, public port: number) {
    // ponytail: ambiguous in-flight delivery never auto-replays; inspect session then retry explicitly.
    for (const m of store.all('messages').filter(m=>m.status==='processing')) store.patch('messages',m.id,{status:'uncertain',error:'Server restarted; inspect session before retry'});
    for (const a of store.all('agents').filter(a=>a.status==='working')) store.patch('agents',a.id,{status:'unknown',error:'Server restarted; verify OpenCode session state'});
  }
  log(kind: string,data: any,projectID?: string) { this.store.add('logs',{kind,data,projectID}); this.changed(); }
  async health() {
    try {
      const {info,client} = await connect(); this.connection={status:'connected',version:info.version};
      for(const a of this.store.all('agents').filter(a=>a.sessionID)) {
        const pending=await client.permission.list({sessionID:a.sessionID});
        if(pending.length)this.store.patch('agents',a.id,{status:'blocked',error:'Chờ human approval trong OpenCode',pendingPermission:pending});
      }
    } catch(e) { this.connection={status:'error',error:String(e)}; }
    this.changed();
  }
  async project(input: unknown) {
    const p=z.object({name:text,path:text}).parse(input);
    const path=await realpath(p.path);
    const root=(await exec('git',['-C',path,'rev-parse','--show-toplevel'])).stdout.trim();
    if(path!==await realpath(root)) throw new Error('Chọn Git project root; cần ít nhất một commit để tạo worktree');
    await exec('git',['-C',path,'rev-parse','HEAD']);
    if(this.store.all('projects').some(p=>p.path===path)) throw new Error('Project đã tồn tại');
    const project=this.store.add('projects',{...p,path,paused:false}); this.changed(); return project;
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
    if(p.status==='In Progress' && t.dependencies.some((id:string)=>this.store.get('tasks',id).status!=='Done')) throw new Error('Dependency chưa Done');
    if(!['user','admin','qa',t.assignee].includes(actor)) throw new Error('Không có quyền cập nhật task');
    const result=this.store.patch('tasks',id,p); this.changed(); return result;
  }
  send(input: unknown,sender='user',parent?: any) {
    const m=messageSchema.parse(input); this.store.get('projects',m.projectID);
    const old=this.store.all('messages').find(v=>v.idempotencyKey===m.idempotencyKey);
    if(old) { if(old.projectID!==m.projectID || old.sender!==sender || old.body!==m.body || old.receiver!==m.receiver) throw new Error('Idempotency key conflict'); return old; }
    const hops=parent ? parent.hops+1:0;
    if(hops>6) throw new Error('Conversation hop limit 6; cần người dùng mở lượt mới');
    const result=this.store.add('messages',{...m,sender,status:'queued',attempts:0,hops,threadID:parent?.threadID??randomUUID(),parentID:parent?.id});
    this.changed(); return result;
  }
  async agent(projectID: string,role: string) {
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
    const session=await client.session.create({title:`AI Team ${p.name} / ${role}`,location:{directory},permissions});
    const selected=session.model?`${session.model.providerID}/${session.model.id}`:'';
    return this.store.patch('agents',a.id,{directory,sessionID:session.id,status:'idle',permissions,model:selected});
  }
  async tick() {
    for(const m of this.store.all('messages').filter(m=>m.status==='queued')) {
      const role=m.receiver==='team'?'admin':m.receiver;
      const key=`${m.projectID}:${role}`;
      if(this.running.has(key)||this.store.get('projects',m.projectID).paused) continue;
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
      const prompt=`You are ${role} of a real software team. Your private worktree: ${agent.directory}. Project canonical checkout: ${this.store.get('projects',m.projectID).path}. Never modify another checkout. Never push, deploy, modify credentials, or destroy data. Ask human for shell permission. Use team MCP tools to coordinate; sender identity is bound to your session. Task completion requires QA test evidence, then human integration approval. Do not claim success without evidence. Admin: inspect code, create concrete backlog with team_update_task (action=create), priorities, dependencies, criteria; delegate via team_send_message; resolve blockers and request QA review. QA: inspect actual diffs, run real tests with permission; create bug tasks and send repair requests. All roles: use team_get_inbox and project context. Cross-worktree code is not integrated until human approval; never silently merge.\nMessage ID ${m.id}, from ${m.sender}, thread ${m.threadID}, hops ${m.hops}/6:\n${m.body}\nTasks/context: ${JSON.stringify(this.store.all('tasks').filter(t=>t.projectID===m.projectID))}`;
      const inbox=await client.session.prompt({sessionID:agent.sessionID,text:prompt});
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
      this.store.patch('agents',agent.id,{status:'idle',currentMessageID:null});
    } catch(e) {
      this.store.patch('messages',m.id,{status:'uncertain',error:String(e)});
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
