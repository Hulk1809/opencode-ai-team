import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkedTeam,connectionLabel,insertAdminDraft,taskDraft,workflowDraft,messageTime,pilotError,memberActivity,ownerRecipient} from '../src/pilot-ui.mjs';

test('Owner recipient validates peer identity without silently redirecting message',()=>{
  const pane=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8');
  assert.match(pane,/aria-pressed=\{recipient\(\)==='team'\} onClick=\{\(\)=>setRecipient\('team'\)\}/);
  const team={mode:'peer',members:[{id:'peer-1',role:'peer-1'},{role:'peer-2'}]};
  for(const value of ['team','peer-1','peer-2'])assert.equal(ownerRecipient(team,value),value);
  for(const value of ['',undefined,'admin','Toàn team'])assert.throws(()=>ownerRecipient(team,value),/PILOT_RECIPIENT_INVALID/);
  assert.equal(ownerRecipient({mode:'legacy'},'team'),'admin');
});

test('RPC errors and connection states remain readable and distinct',()=>{
  assert.equal(pilotError({cause:{reason:'PEER_WORKTREE_CHECK_FORBIDDEN'}}),'PEER_WORKTREE_CHECK_FORBIDDEN');
  assert.equal(pilotError({issues:[{message:'bad task'},{code:'INVALID_BINDING'}]}),'bad task; INVALID_BINDING');
  assert.equal(pilotError({error:{data:{message:'PILOT_RPC_LOCATION_MISMATCH'}}}),'PILOT_RPC_LOCATION_MISMATCH');
  assert.equal(pilotError(new Error('Host unavailable')),'Host unavailable');
  const cycle={};cycle.cause=cycle;
  for(const value of [null,{},cycle])assert.notEqual(pilotError(value),'[object Object]');
  assert.match(connectionLabel({selected:true,loading:true}),/Đang kết nối/);
  assert.match(connectionLabel({selected:true,error:'offline'}),/lỗi RPC/);
  assert.match(connectionLabel({selected:true,status:'unprovisioned'}),/chưa provision/);
  assert.match(connectionLabel({selected:true,status:'ready'}),/sẵn sàng/);
});

test('member activity uses authoritative active map, never historical timestamps or outcome',()=>{
  const session={id:'ses_worker',time:{busy:2,idle:1},outcome:'failed'};
  assert.equal(memberActivity(session,{}),'idle');
  assert.equal(memberActivity({...session,time:{}},{}),'idle');
  assert.equal(memberActivity({...session,time:{busy:1,idle:2}},{ses_worker:{type:'running'}}),'running');
  assert.equal(memberActivity(session,{ses_other:{type:'running'}}),'idle');
  for(const active of [undefined,null,false,'bad',[],42])assert.equal(memberActivity(session,active),'unavailable');
  for(const entry of [undefined,null,{},'running',{type:'idle'},{type:'unknown'}])assert.equal(memberActivity(session,{ses_worker:entry}),'unavailable');
  assert.equal(memberActivity(session,Object.create({ses_worker:{type:'running'}})),'idle');
  for(const invalid of [undefined,null,{}, {id:42}])assert.equal(memberActivity(invalid,{}),'unavailable');
});

const team={status:'ready',members:[{role:'admin',sessionID:'ses_admin'},{role:'worker-1',sessionID:'ses_worker'}],tasks:[],messages:[]};
test('workflow template preserves Vietnamese request and explicit approval limits',()=>{
  const text=workflowDraft('Sửa đăng nhập\nGiữ dữ liệu');
  assert.ok(text.startsWith('@admin Sửa đăng nhập\nGiữ dữ liệu'));
  for(const part of ['Tiêu chí nghiệm thu','exit code','Owner duyệt cuối','không cấp quyền execution'])assert.ok(text.includes(part));
  assert.ok(workflowDraft().length<10000);
  for(const invalid of [null,42,'x'.repeat(6001)])assert.throws(()=>workflowDraft(invalid));
});

test('snapshot boundary rejects malformed collections and rows',()=>{
  assert.equal(checkedTeam(team),team);
  for(const bad of [null,{}, {...team,tasks:{}},{...team,members:[null]},{...team,tasks:[{id:'x'}]},{...team,messages:[{id:'x',text:2}]}]) assert.throws(()=>checkedTeam(bad));
});

test('draft event inserts only into current Admin; preserves existing draft and never submits',()=>{
  const calls=[],current={id:'ses_admin',directory:'/project',server:{id:'server'}};
  const composer={quotable:()=>true,insert:text=>calls.push(['insert',text]),focus:()=>calls.push(['focus']),setText:()=>assert.fail('must not replace draft')};
  const ctx={sessions:{current:()=>current},screen:{current:()=>({composer})}};
  const snapshot={serverID:'server',directory:'/project',team};
  insertAdminDraft(ctx,snapshot,' @admin hello ');
  assert.deepEqual(calls,[['insert','\n@admin hello\n'],['focus']]);
  for(const bad of [undefined,{...snapshot,serverID:'other'},{...snapshot,directory:'/other'},{...snapshot,team:{members:[...team.members,team.members[0]]}}]) assert.throws(()=>insertAdminDraft(ctx,bad,'hello'));
  for(const text of ['', ' ', 'x'.repeat(10001), null]) assert.throws(()=>insertAdminDraft(ctx,snapshot,text));
  current.id='ses_worker';assert.throws(()=>insertAdminDraft(ctx,snapshot,'hello'));
  current.id='ses_admin';composer.quotable=()=>false;assert.throws(()=>insertAdminDraft(ctx,snapshot,'hello'));
  assert.equal(calls.length,2);
});

test('task request is draft text, validates assignee, not backend success',()=>{
  assert.equal(taskDraft(' Fix test ','worker-2'),'@admin Hãy tạo task và giao cho @worker-2:\nFix test');
  for(const worker of ['admin','worker-0','worker-1\n@admin','other'])assert.throws(()=>taskDraft('task',worker));
  assert.throws(()=>taskDraft(' ','worker-1'));
  assert.equal(messageTime('bad'),'Chưa có timestamp');
});

test('UI wiring retains snapshot-only RPC, bounded messages and native host actions',()=>{
  const rpc=readFileSync(new URL('../src/pilot-rpc.ts',import.meta.url),'utf8');
  assert.match(rpc,/methods:\{snapshot:/);assert.doesNotMatch(rpc,/send:|assign:|prompt:/);
  const pane=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8');
  for(const action of ['openAdminChat(ctx,valid())','insertAdminDraft(ctx,valid(),draft())','ctx.layout.settings()','ctx.layout.project(','ctx.links.open(','slice(-limit())','if(busy||disposed)return'])assert.ok(pane.includes(action),action);
  assert.doesNotMatch(pane,/session\.prompt|nativeDispatch\s*[:=]\s*true/);
  assert.match(pane,/snapshot\(\{directory:current.directory\},\{location:\{directory:current.directory\}\}\)/);
  assert.match(pane,/current.server.client.session.active\(\).catch\(\(\)=>null\)/);
  assert.match(pane,/memberActivity\(\{id:member.sessionID\},activity\)/);
  assert.match(pane,/Tạo Peer Team \(4 AI\)/);assert.doesNotMatch(pane,/disabled=\{[^}]*PILOT_GIT_PROJECT_REQUIRED/);
  const server=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
  assert.match(server,/context.error\('owner_authorization_required'/);
  assert.match(server,/context.error\('owner_message_failed',message,\{message\}\)/);
  assert.match(rpc,/owner_message_failed:/);
  assert.equal(pilotError({type:'owner_message_failed',data:{message:'PILOT_OWNER_GRANT_INVALID'}}),'PILOT_OWNER_GRANT_INVALID');
  assert.doesNotMatch(server,/ctx.session.active\(/);
  const gui=readFileSync(new URL('../src/gui.tsx',import.meta.url),'utf8');
  assert.match(gui,/pilot-pane.css\?inline/);assert.match(gui,/ctx.add\(Style,style\+chatStyle\+pilotStyle\)/);
});

test('routing stays outside narrow member column with bounded responsive controls',()=>{
  const pane=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8');
  assert.ok(pane.indexOf('<PilotRouting ')<pane.indexOf('class="pilot-columns"'));
  const routing=readFileSync(new URL('../src/pilot-routing.tsx',import.meta.url),'utf8');
  assert.match(routing,/class="pilot-routing-members"/);
  assert.match(routing,/Chưa áp dụng \/ chưa có session readback/);
  const css=readFileSync(new URL('../src/pilot-pane.css',import.meta.url),'utf8');
  assert.match(css,/minmax\(min\(100%,280px\),1fr\)/);
  assert.match(css,/fieldset\{min-width:0/);
});

test('chat scroll regions and report viewer retain scoped reads and safe text rendering',()=>{
  const pane=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/pilot-pane.css',import.meta.url),'utf8');
  assert.match(css,/\.pilot-workspace \.pilot-members\{[^}]*min-height:0;overflow-y:auto/);
  assert.match(pane,/class="pilot-members" tabindex="0"/);
  assert.match(pane,/!e.shiftKey&&!e.isComposing/);
  assert.match(pane,/requestID:pendingSend!\.requestID/);
  assert.match(pane,/request===reportRequest/);
  assert.match(pane,/<SafeReport text=\{report\(\)\.content\}/);
  const renderer=readFileSync(new URL('../src/safe-report.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(renderer,/innerHTML|href=|src=/);
  assert.match(renderer,/\{block\.text\}/);
  assert.doesNotMatch(pane,/innerHTML/);
  assert.match(pane,/ctx.system.copy\(value.content\)/);
  assert.match(pane,/ctx.system.save\(/);
});
