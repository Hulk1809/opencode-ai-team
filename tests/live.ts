// Real service integration, opt-in: node --import tsx tests/live.ts
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const base='http://127.0.0.1:4310';
const token=readFileSync('.data/token','utf8').trim();
const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});
assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
async function api(path:string,body?:any) {const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
const dir=mkdtempSync('/tmp/opencode/team-live-');
execFileSync('git',['init','-q',dir]);writeFileSync(dir+'/README.md','# Live integration fixture\n');
execFileSync('git',['-C',dir,'add','README.md']);execFileSync('git',['-C',dir,'-c','user.name=Team Test','-c','user.email=test@localhost','commit','-qm','fixture']);
const project=await api('/projects',{name:'Live acceptance fixture',path:dir});
const message=await api('/messages',{projectID:project.id,receiver:'backend',body:'Integration check. Create file integration-proof.txt containing exactly REAL_AGENT_WRITE using file edit tool in your own worktree. Then use team_send_message to ask frontend: "Read README.md and reply through team_send_message to backend with exact text FRONTEND_RECEIVED. Do not send further questions." Use unique idempotencyKey. No shell needed. Report honestly any blocker.',idempotencyKey:`live-${project.id}`});
let state:any;
const deadline=Date.now()+240000;
while(Date.now()<deadline) {
  state=await api('/state?projectID='+project.id);
  const original=state.messages.find((m:any)=>m.id===message.id);
  if(original?.status==='uncertain') break;
  if(state.messages.some((m:any)=>m.sender==='frontend'&&m.receiver==='backend'&&m.body.includes('FRONTEND_RECEIVED'))) break;
  await new Promise(r=>setTimeout(r,2000));
}
const backend=state.agents.find((a:any)=>a.role==='backend');
console.log(JSON.stringify({projectID:project.id,directory:dir,connection:state.connection,agents:state.agents.map((a:any)=>({role:a.role,sessionID:a.sessionID,status:a.status,error:a.error})),messages:state.messages.map((m:any)=>({sender:m.sender,receiver:m.receiver,status:m.status,body:m.body,error:m.error})),fileWritten:backend&&existsSync(backend.directory+'/integration-proof.txt')},null,2));
assert.ok(backend&&existsSync(backend.directory+'/integration-proof.txt'),'Real file write not proven');
assert.ok(state.messages.some((m:any)=>m.sender==='frontend'&&m.receiver==='backend'&&m.body.includes('FRONTEND_RECEIVED')),'Real Backend → Frontend → Backend bus not proven');
