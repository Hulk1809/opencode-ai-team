// Opt-in real model survey. Creates Git fixture, never approves coding.
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const dir=mkdtempSync('/tmp/opencode/survey-live-');
execFileSync('git',['init','-q',dir]);writeFileSync(dir+'/README.md','# Survey fixture\nOnly documentation exists. No implementation or tests. Goal not specified.\n');
execFileSync('git',['-C',dir,'add','README.md']);execFileSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']);
const token=readFileSync('.data/token','utf8').trim();
async function api(path:string,body?:unknown){const r=await fetch('http://127.0.0.1:4310/api'+path,{method:body?'POST':'GET',headers:{cookie:`team=${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
const project=await api('/projects',{name:'Read-only survey live fixture',path:dir});
const deadline=Date.now()+300000;let state:any;
while(Date.now()<deadline){state=await api('/state?projectID='+project.id);if(state.projects.find((p:any)=>p.id===project.id)?.proposal||state.messages.some((m:any)=>m.status==='uncertain'))break;await new Promise(r=>setTimeout(r,1500));}
const p=state.projects.find((p:any)=>p.id===project.id);
console.log(JSON.stringify({projectID:project.id,onboarding:p.onboarding,proposal:p.proposal,agents:state.agents.map((a:any)=>({role:a.role,sessionID:a.sessionID,status:a.status,error:a.error})),errors:state.messages.filter((m:any)=>m.error).map((m:any)=>m.error)},null,2));
assert.equal(p.onboarding,'awaiting_approval');assert.ok(p.proposal);
assert.ok(state.agents.every((a:any)=>a.role==='admin'));assert.equal(execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8'}),'');
