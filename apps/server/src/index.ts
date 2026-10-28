import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { Team } from './team.ts';
import { connect } from './opencode.ts';
import { handleMcp } from '../../../packages/team-mcp/src/index.ts';

const port=z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT??4310);
const data=resolve(process.env.TEAM_DATA_DIR??'.data');mkdirSync(data,{recursive:true,mode:0o700});
let token=process.env.TEAM_TOKEN;
if(!token) {try {token=readFileSync(resolve(data,'token'),'utf8').trim();} catch {token=randomBytes(32).toString('hex');writeFileSync(resolve(data,'token'),token,{mode:0o600,flag:'wx'});} }
if(token.length<32) throw new Error('TEAM_TOKEN cần ít nhất 32 ký tự');
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(req.hostname)) {res.status(403).json({error:'Invalid Host'});return;}
  if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) {res.status(403).json({error:'Cross-origin denied'});return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');next();
});
app.use(express.json({limit:'128kb'}));
const store=new Store(resolve(data,'team.sqlite'));
const team=new Team(store,data,port);
const subscribers=new Set<express.Response>();team.changed=()=>{for(const res of subscribers)res.write('event: change\ndata: {}\n\n');};
let loginAttempts=0;
setInterval(()=>loginAttempts=0,60000).unref();
app.post('/api/login',(req,res)=>{
  if(++loginAttempts>30){res.status(429).json({error:'Thử lại sau 60 giây'});return;}
  if(typeof req.body.token!=='string'||!equal(req.body.token,token!)){res.status(401).json({error:'Invalid token'});return;}
  res.setHeader('Set-Cookie',`team=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);res.json({ok:true});
});
app.all('/mcp/:agentID',async(req,res)=>{
  const agent=store.all('agents').find(a=>a.id===req.params.agentID);
  if(!agent||!equal(req.headers.authorization??'',`Bearer ${agent.capability}`)){res.status(401).json({error:'Unauthorized'});return;}
  if(req.method!=='POST'){res.status(405).end();return;}
  await handleMcp(team,req,res,agent);
});
app.use('/api',(req,res,next)=>{
  const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('team='))?.slice(5)??'';
  if(!equal(cookie,token!)){res.status(401).json({error:'Đăng nhập bằng token trong terminal'});return;}next();
});
app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Connection','keep-alive');res.flushHeaders();res.write('event: change\ndata: {}\n\n');subscribers.add(res);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{clearInterval(heartbeat);subscribers.delete(res);});});
app.get('/api/state',(req,res)=>{
  const projectID=typeof req.query.projectID==='string'?req.query.projectID:undefined;
  const state:any={projects:store.all('projects'),connection:team.connection};
  for(const kind of ['agents','tasks','messages','logs']) state[kind]=store.all(kind).filter(v=>!projectID||v.projectID===projectID).map(({capability,...v})=>v);
  res.json(state);
});
app.post('/api/projects',async(req,res)=>res.json(await team.project(req.body)));
app.post('/api/projects/:id/pause',(req,res)=>{const {paused}=z.object({paused:z.boolean()}).parse(req.body);res.json(store.patch('projects',req.params.id,{paused}));team.changed();});
app.post('/api/messages',(req,res)=>res.json(team.send(req.body)));
app.post('/api/messages/:id/retry',(req,res)=>{const m=store.get('messages',req.params.id);if(!['error','uncertain'].includes(m.status)||m.attempts>=3)throw new Error('Retry chỉ cho error/uncertain, tối đa 3 lần');store.patch('messages',m.id,{status:'queued',error:null});team.changed();res.json({ok:true});});
app.post('/api/tasks',(req,res)=>res.json(team.task(req.body)));
app.post('/api/tasks/:id',(req,res)=>res.json(team.updateTask(req.params.id,req.body,'user')));
app.post('/api/tasks/:id/approve',(req,res)=>{const t=store.get('tasks',req.params.id);if(t.status!=='Done'||!t.evidence)throw new Error('Cần QA Done với evidence');res.json(store.patch('tasks',t.id,{approved:true,approvedAt:new Date().toISOString()}));team.changed();});
app.post('/api/agents/:id',async(req,res)=>{const {model}=z.object({model:z.string().min(3).max(200)}).parse(req.body);await team.setModel(req.params.id,model);res.json({ok:true});});
app.get('/api/models',async(_req,res)=>{const {client}=await connect();const models=await client.model.list();res.json(JSON.parse(JSON.stringify(models,(key,value)=>['settings','headers','apiKey','auth','password','token'].includes(key)?undefined:value)));});
app.get('/api/projects/:id/diff',async(req,res)=>res.json({diff:await team.diff(req.params.id)}));
app.use('/api',(_req,res)=>res.status(404).json({error:'Not found'}));
app.use(express.static(resolve('apps/web/dist')));
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(JSON.stringify({kind:'http.error',error:String(err)}));if(!res.headersSent)res.status(err instanceof z.ZodError?400:409).json({error:String(err)});});
app.listen(port,'127.0.0.1',()=>{console.log(`Dashboard http://127.0.0.1:${port}\nLogin token: ${token}`);});
void team.health();setInterval(()=>void team.health(),15000).unref();setInterval(()=>void team.tick(),1000).unref();
async function events() {
  for(;;) {
    try {const {client}=await connect();for await(const event of client.event.subscribe()) {
      const raw=event as any;
      const sessionID=raw.sessionID??raw.data?.sessionID??raw.properties?.sessionID;
      const a=store.all('agents').find(a=>a.sessionID===sessionID);
      if(a) {
        if(raw.type==='permission.asked')store.patch('agents',a.id,{status:'blocked',error:'Chờ human approval trong OpenCode',pendingPermission:raw.data});
        if(raw.type==='permission.replied')store.patch('agents',a.id,{status:'working',error:null,pendingPermission:null});
        team.log('opencode.event',event,a.projectID);
      }
    }} catch(e) {team.connection={status:'error',error:String(e)};team.changed();}
    await new Promise(r=>setTimeout(r,5000));
  }
}
void events();
