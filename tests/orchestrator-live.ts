// Opt-in live Admin → Backend → QA acceptance test, consumes real model usage.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base='http://127.0.0.1:4310';
const token=readFileSync('.data/token','utf8').trim();
const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});
const cookie=login.headers.get('set-cookie')!.split(';')[0];
async function api(path:string,body?:any){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
const dir=mkdtempSync('/tmp/opencode/team-admin-');execFileSync('git',['init','-q',dir]);
writeFileSync(dir+'/sum.mjs','export function sum(a,b) { return a-b; }\n');
writeFileSync(dir+'/sum.test.mjs',"import assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\nassert.equal(sum(2,3),5);\nconsole.log('sum test passed');\n");
execFileSync('git',['-C',dir,'add','.']);execFileSync('git',['-C',dir,'-c','user.name=Team Test','-c','user.email=test@localhost','commit','-qm','bug fixture']);
const project=await api('/projects',{name:'Admin QA acceptance fixture',path:dir});
await api('/messages',{projectID:project.id,receiver:'admin',idempotencyKey:`admin-${project.id}`,body:'Inspect this tiny repo with read tools. sum.mjs has a real arithmetic bug, sum.test.mjs exposes it. Use team_update_task to create one backend bug-fix task with concrete test acceptance criterion. Delegate backend using team_send_message. Backend must inspect and fix sum.mjs in own worktree, request QA review via team_request_review, include actual path. QA must inspect actual backend file/test, request shell permission to execute node sum.test.mjs in backend worktree, and only mark Done with passing test evidence. Do not merge, push or invent test results. Stop and report permission blocker if human approval needed.'});
const deadline=Date.now()+180000;let state:any;
while(Date.now()<deadline){state=await api('/state?projectID='+project.id);if(state.tasks.some((t:any)=>t.status==='Done'||t.status==='Blocked'))break;if(state.messages.some((m:any)=>m.status==='uncertain'))break;await new Promise(r=>setTimeout(r,2000));}
const agents=state.agents.map((a:any)=>({role:a.role,sessionID:a.sessionID,directory:a.directory,status:a.status,error:a.error}));
const backend=state.agents.find((a:any)=>a.role==='backend');
console.log(JSON.stringify({projectID:project.id,agents,tasks:state.tasks,messages:state.messages.map((m:any)=>({sender:m.sender,receiver:m.receiver,status:m.status,body:m.body,error:m.error})),backendFile:backend&&existsSync(backend.directory+'/sum.mjs')?readFileSync(backend.directory+'/sum.mjs','utf8'):null},null,2));
assert.ok(state.tasks.length>0,'Admin backlog not proven');
assert.ok(state.messages.some((m:any)=>m.sender==='admin'&&m.receiver==='backend'),'Admin delegation not proven');
assert.ok(state.tasks.some((t:any)=>t.status==='Done'&&t.evidence),'QA verification not proven; see blockers/permissions');
