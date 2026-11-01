import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamRoom, extractAssistant, dependencyCycles, rateLimitDecision } from '../src/room.mjs';
const directory='/tmp/project';
const roles=['admin','frontend','backend','devops','qa'];
function fake() {
  const store=new Map(); const calls=[]; const transcripts=new Map();
  const ctx={
    storage:{get:async k=>structuredClone(store.get(k)),set:async(k,v)=>{store.set(k,structuredClone(v))}},
    agent:{list:async()=>({data:roles.map(id=>({id}))})},
    session:{
      create:async o=>{calls.push(o);return {id:`s-${o.title.split(' | ').at(-1)}`}},
      switchAgent:async o=>{calls.push({switchRole:o.agent,sessionID:o.sessionID})},
      prompt:async o=>{calls.push(o);const rows=transcripts.get(o.sessionID) ?? [];rows.push({id:o.id,type:'user',text:o.text});transcripts.set(o.sessionID,rows);return {id:o.id}},
      context:async o=>(transcripts.get(o.sessionID) ?? [])
    }
  };
  return {room:new TeamRoom(ctx), calls, transcripts, store};
}
test('atomic batch fans out once, persists dedup, rejects cycles and isolates dispatch failure',async()=>{
  const {room,calls}=fake();await room.create(directory);
  const tasks=['backend','frontend','devops','qa'].map(assignee=>({key:assignee,assignee,title:assignee,description:'Read-only inspection'}));
  const first=await room.assignBatch(directory,'admin',{requestID:'batch-1',tasks});
  assert.equal(first.tasks.length,4);assert.equal(new Set(first.tasks.map(x=>x.task.id)).size,4);
  assert.ok(first.tasks.every(x=>x.request.status==='admitted'));
  const prompts=calls.filter(c=>c.text).length;
  assert.equal((await room.assignBatch(directory,'admin',{requestID:'batch-1',tasks})).id,first.id);
  assert.equal(calls.filter(c=>c.text).length,prompts);
  const reopened=new TeamRoom(room.ctx);assert.equal((await reopened.assignBatch(directory,'admin',{requestID:'batch-1',tasks})).id,first.id);assert.equal(calls.filter(c=>c.text).length,prompts);
  await assert.rejects(room.assignBatch(directory,'admin',{requestID:'batch-1',tasks:tasks.slice(0,1)}),/nội dung khác/);
  await assert.rejects(room.assignBatch(directory,'backend',{requestID:'bad',tasks}),/Admin/);
  await assert.rejects(room.assignBatch(directory,'admin',{requestID:'cycle',tasks:tasks.map(t=>({...t,dependencies:[t.key]}))}),/cycle/);
  assert.equal((await room.read(directory)).batches.length,1);
});
test('batch dependencies wait without blocking independent roles; concurrency and failures stay bounded',async()=>{
  const {room}=fake();await room.create(directory);let active=0,peak=0;const release=[];
  room.ctx.session.prompt=async o=>{active++;peak=Math.max(peak,active);await new Promise(r=>release.push(r));active--;if(o.sessionID==='s-devops')throw Error('permission denied');return {id:o.id};};
  const tasks=['backend','frontend','devops','qa'].map(assignee=>({key:assignee,assignee,title:assignee,description:'Inspect',dependencies:assignee==='qa'?['backend']:[]}));
  const work=room.assignBatch(directory,'admin',{requestID:'deps',tasks});
  while(release.length<3)await new Promise(r=>setImmediate(r));
  assert.equal(peak,3);release.forEach(r=>r());const batch=await work;
  assert.equal(batch.tasks.find(x=>x.task.assignee==='qa').request.status,'waiting');
  assert.equal(batch.tasks.find(x=>x.task.assignee==='devops').request.status,'uncertain');
  assert.equal(batch.tasks.find(x=>x.task.assignee==='frontend').request.status,'admitted');
});
test('teams are keyed by project directory and reopening does not create duplicate sessions',async()=>{
  const {room,calls}=fake();await room.create('/tmp/project-one');await room.create('/tmp/project-two');
  const created=calls.filter(c=>c.title).length;assert.equal(created,10);
  await room.create('/tmp/project-one');assert.equal(calls.filter(c=>c.title).length,created);
  const one=await room.read('/tmp/project-one'),two=await room.read('/tmp/project-two');
  one.tasks=[{id:'only-one'}];one.members.backend.buildEnvironment={id:'only-one-scope'};await room.write('/tmp/project-one',one);
  assert.equal(two.directory,'/tmp/project-two');assert.equal((await room.read('/tmp/project-two')).tasks,undefined);assert.equal((await room.read('/tmp/project-two')).members.backend.buildEnvironment,undefined);
});
test('done-worker controls need reconciliation, not model calls; explicit review state permits dispatch',async()=>{
  const {room,calls}=fake();await room.create(directory);
  const team=await room.read(directory);team.tasks=[{id:'t',status:'done',dependencies:[],completionRevision:1}];await room.write(directory,team);
  const id=await room.send(directory,'admin','qa','review approved, no coding',{kind:'control',taskID:'t',idempotencyKey:'review-ack'});
  let current=await room.read(directory);assert.equal(current.messages.find(m=>m.id===id).status,'needs_review');assert.equal(calls.filter(c=>c.text).length,0);
  assert.equal(await room.send(directory,'admin','qa','review approved, no coding',{kind:'control',taskID:'t',idempotencyKey:'review-ack'}),id);
  current.tasks[0].status='review';await room.write(directory,current);
  const review=await room.send(directory,'admin','qa','explicit review requested',{kind:'control',taskID:'t'});
  current=await new TeamRoom(room.ctx).sync(directory);
  assert.equal(current.messages.find(m=>m.id===id).status,'needs_review');assert.equal(current.messages.find(m=>m.id===review).status,'admitted');assert.equal(calls.filter(c=>c.text).length,1);
  assert.equal(current.tasks[0].completionRevision,1);
});
test('controlled 429 policy is bounded and leaves 400 validation and session errors untouched',()=>{
  assert.deepEqual(rateLimitDecision({status:429},0),{retry:true,delay:1000});
  assert.deepEqual(rateLimitDecision({status:429,retryAfterMs:900000},1),{retry:true,delay:300000});
  assert.deepEqual(rateLimitDecision({status:429},4),{retry:false,delay:16000});
  assert.deepEqual(rateLimitDecision({status:429,retryAfterMs:300000},4),{retry:false,delay:300000});
  assert.equal(rateLimitDecision({status:400},0),undefined);assert.equal(rateLimitDecision({status:500},0),undefined);
});
test('controlled provider cooldown prevents admission; expired cooldown recovers without data loss',async()=>{
  const {room,calls}=fake();await room.create(directory);const t=await room.read(directory);t.providerCooldowns={unknown:{until:new Date(Date.now()+60000).toISOString(),attempt:1}};t.tasks=[{id:'t',status:'working',dependencies:[]}];t.files=[{id:'artifact',checksum:'retained'}];await room.write(directory,t);
  const id=await room.send(directory,'owner','backend','cooldown request',{taskID:'t'});assert.equal(calls.filter(c=>c.text).length,0);
  const saved=await room.read(directory);saved.providerCooldowns.unknown.until='2000-01-01T00:00:00Z';await room.write(directory,saved);
  await new TeamRoom(room.ctx).drain(directory);const recovered=await room.read(directory);assert.equal(recovered.messages.find(m=>m.id===id).status,'admitted');assert.deepEqual(recovered.tasks,t.tasks);assert.deepEqual(recovered.files,t.files);assert.deepEqual(recovered.members,t.members);assert.equal(calls.filter(c=>c.text).length,1);
});
test('dependency graph detects cycles and emits durable deduplicated alert without changing tasks',async()=>{
  const tasks=[{id:'a',status:'todo',dependencies:['b']},{id:'b',status:'blocked',dependencies:['a']},{id:'self',status:'todo',dependencies:['self']},{id:'done',status:'done',dependencies:['done']}];
  assert.deepEqual(dependencyCycles(tasks),[['a','b'],['self']]);
  const {room}=fake();await room.create(directory);const t=await room.read(directory);t.tasks=tasks;await room.write(directory,t);
  await room.drain(directory);await new TeamRoom(room.ctx).drain(directory);const result=await room.read(directory);
  assert.equal(result.messages.filter(m=>m.eventType==='queue.deadlock').length,2);assert.deepEqual(result.tasks,tasks);
});
test('control burst fairness survives recovery and preserves both FIFO orders',async()=>{
  const {room,transcripts,calls}=fake();await room.create(directory);
  // Occupy session while both queues fill.
  await room.send(directory,'owner','qa','initial',{kind:'control'});
  const execution=await room.send(directory,'owner','qa','execute');
  const controls=[];for(let i=0;i<4;i++)controls.push(await room.send(directory,'owner','qa',`control-${i}`,{kind:'control'}));
  for(let i=0;i<3;i++){transcripts.get('s-qa').push({id:`idle-${i}`,type:'idle',outcome:'succeeded'});await new TeamRoom(room.ctx).sync(directory);}
  const t=await room.read(directory);assert.equal(t.messages.find(m=>m.id===execution).status,'admitted');assert.equal(t.messages.find(m=>m.id===controls[2]).status,'waiting');
  const prompts=calls.filter(c=>c.text).map(c=>c.id);assert.deepEqual(prompts,t.messages.filter(m=>m.promptID&&['initial','control-0','control-1','execute'].includes(m.text)).sort((a,b)=>['initial','control-0','control-1','execute'].indexOf(a.text)-['initial','control-0','control-1','execute'].indexOf(b.text)).map(m=>m.promptID));
});
test('control bypasses blocked execution, preserves execution FIFO and does not fabricate answers',async()=>{
  const {room,calls,transcripts}=fake();await room.create(directory);
  const team=await room.read(directory);team.tasks=[{id:'blocked',status:'blocked',dependencies:[]}];await room.write(directory,team);
  team.controlBursts={qa:3};await room.write(directory,team);
  const head=await room.send(directory,'owner','qa','blocked execution',{taskID:'blocked'});
  const later=await room.send(directory,'owner','qa','later execution');
  const control=await room.send(directory,'owner','qa','review correction',{kind:'control',taskID:'blocked',idempotencyKey:'correction'});
  assert.equal(await room.send(directory,'owner','qa','review correction',{kind:'control',taskID:'blocked',idempotencyKey:'correction'}),control);
  assert.equal(calls.filter(c=>c.text).length,1);
  let current=await room.read(directory);assert.equal(current.messages.find(m=>m.id===head).status,'waiting');assert.equal(current.messages.find(m=>m.id===later).status,'waiting');
  transcripts.get('s-qa').push({id:'control-idle',type:'idle',outcome:'succeeded'});
  current=await new TeamRoom(room.ctx).sync(directory);
  assert.equal(current.messages.find(m=>m.id===control).status,'answered');assert.equal(current.messages.find(m=>m.id===head).status,'waiting');
});
test('stall alert persists once; legacy unscoped waiting quarantined without replay',async()=>{
  const {room,calls}=fake();await room.create(directory);
  const t=await room.read(directory);t.tasks=[{id:'blocked',status:'blocked',dependencies:[]}];
  t.messages.push({id:'legacy',promptID:'legacy-prompt',from:'qa',to:'backend',text:'keep',status:'waiting'});await room.write(directory,t);
  const id=await room.send(directory,'owner','qa','blocked',{taskID:'blocked'});
  const current=await room.read(directory);current.messages.find(m=>m.id===id).blockedSince='2000-01-01T00:00:00Z';await room.write(directory,current);
  await room.drain(directory);await new TeamRoom(room.ctx).drain(directory);
  const result=await room.read(directory);assert.equal(result.messages.find(m=>m.id==='legacy').status,'needs_review');assert.equal(result.messages.filter(m=>m.eventType==='queue.stalled').length,1);assert.ok(!calls.some(c=>c.id==='legacy-prompt'));
});
test('stability: idempotency, tool-only idle, completed task expires without losing request',async()=>{
  const {room,calls,transcripts}=fake();await room.create(directory);
  const id=await room.send(directory,'owner','backend','same',{idempotencyKey:'stable-key'});
  assert.equal(await room.send(directory,'owner','backend','same',{idempotencyKey:'stable-key'}),id);
  assert.equal(calls.filter(c=>c.text).length,1);
  await assert.rejects(()=>room.send(directory,'owner','backend','different',{idempotencyKey:'stable-key'}),/nội dung khác/);
  transcripts.get('s-backend').push({id:'tool-only',type:'assistant',time:{created:1},content:[{type:'tool'}]},{id:'end',type:'idle',outcome:'succeeded'});
  await room.sync(directory);
  let team=await room.read(directory);assert.equal(team.messages.find(m=>m.id===id).lifecycle,'answered');
  team.tasks=[{id:'done-task',status:'done'}];await room.write(directory,team);
  const expired=await room.send(directory,'owner','qa','obsolete',{taskID:'done-task'});
  team=await room.read(directory);assert.equal(team.messages.find(m=>m.id===expired).status,'expired');
  assert.equal(team.messages.find(m=>m.id===expired).text,'obsolete');assert.equal(team.deadLetters[0].requestID,expired);
});
test('stability: long model run remains processing, not uncertain, after reopen',async()=>{
  const {room,transcripts}=fake();await room.create(directory);
  const id=await room.send(directory,'owner','qa','long');
  const team=await room.read(directory);team.messages.find(m=>m.id===id).dispatchedAt='2000-01-01T00:00:00Z';await room.write(directory,team);
  transcripts.get('s-qa').push({id:'running',type:'assistant',time:{created:1},content:[]});
  const reopened=new TeamRoom(room.ctx);const result=await reopened.sync(directory);
  assert.equal(result.messages.find(m=>m.id===id).lifecycle,'processing');
  assert.equal(result.messages.find(m=>m.id===id).status,'admitted');
});
test('stability: compaction hides prompt from context; durable history reconciles without replay',async()=>{
  const {room,calls,transcripts}=fake();await room.create(directory);
  const id=await room.send(directory,'owner','qa','before compaction');
  const original=transcripts.get('s-qa')[0];
  transcripts.set('s-qa',[{id:'compact',type:'compaction'},{id:'last',type:'idle',outcome:'succeeded'}]);
  room.history=async input=>input.cursor?{data:[{id:'answer',type:'assistant',content:[{type:'text',text:'durable answer'}]},{id:'idle-old',type:'idle',outcome:'succeeded'}],cursor:{}}:{data:[original],cursor:{next:'page2'}};
  const team=await room.sync(directory);
  assert.equal(team.messages.find(m=>m.id===id).status,'answered');
  assert.equal(team.messages.find(m=>m.requestID===id).text,'durable answer');
  assert.equal(calls.filter(c=>c.text).length,1);
});
test('stability: more than 250 messages retain history and idempotency after reconciliation',async()=>{
  const {room,calls,transcripts}=fake();await room.create(directory);
  const team=await room.read(directory);
  team.messages.push(...Array.from({length:260},(_,i)=>({id:`old-${i}`,from:'owner',to:'qa',text:`history ${i}`,status:'answered'})));
  await room.write(directory,team);
  const id=await room.send(directory,'owner','qa','preserve',{idempotencyKey:'retained'});
  transcripts.get('s-qa').push({id:'done',type:'idle',outcome:'succeeded'});
  await room.sync(directory);
  assert.equal((await room.read(directory)).messages.filter(m=>m.id.startsWith('old-')).length,260);
  assert.equal(await room.send(directory,'owner','qa','preserve',{idempotencyKey:'retained'}),id);
  assert.equal(calls.filter(c=>c.text).length,1);
});
test('task-scoped follow-up inherits association and expires after task done without dispatch',async()=>{
  const {room,calls}=fake();await room.create(directory);
  let team=await room.read(directory);team.tasks=[{id:'task-scope',status:'working'}];await room.write(directory,team);
  const parent=await room.send(directory,'owner','backend','work',{taskID:'task-scope'});
  await room.send(directory,'owner','qa','busy');
  const followup=await room.sendAsSession(directory,'s-backend','qa','review');
  team=await room.read(directory);const record=team.messages.find(m=>m.id===followup);
  assert.equal(record.taskID,'task-scope');assert.equal(record.parentRequestID,parent);
  team.tasks[0].status='done';team.messages.find(m=>m.to==='qa'&&m.status==='admitted').status='answered';await room.write(directory,team);
  await room.drain(directory);team=await room.read(directory);
  assert.equal(team.messages.find(m=>m.id===followup).status,'expired');
  assert.equal(calls.filter(c=>c.id===record.promptID).length,0);
  assert.ok(!team.messages.some(m=>m.requestID===followup));
});
test('tạo 5 session riêng, lặp lại không tạo trùng', async()=>{
  const {room,calls}=fake();
  const team=await room.create(directory,'Website');
  assert.equal(team.status,'ready');
  assert.equal(new Set(Object.values(team.members).map(x=>x.sessionID)).size,5);
  await room.create(directory,'Website');
  assert.equal(calls.filter(x=>x.title?.startsWith('AI Team')).length,5);
  assert.deepEqual(calls.filter(x=>x.switchRole).map(x=>x.switchRole),roles);
  assert.ok(calls.filter(x=>x.title).every(x=>x.metadata.teamDirectory===directory));
});
test('team mới chọn GPT medium cho Admin, catalog thiếu thì không tạo/fallback',async()=>{
  const {room}=fake(),changes=[];
  room.ctx.model={list:async()=>[]};
  await assert.rejects(()=>room.create(directory),/không khả dụng/);
  room.ctx.model.list=async()=>[{providerID:'taile',id:'cx/gpt-6.1-sol',variants:[{id:'medium'}]}];
  room.ctx.session.switchModel=async input=>changes.push(input);
  room.ctx.session.get=async()=>({});
  await room.create(directory);assert.deepEqual(changes,[{sessionID:'s-admin',model:{providerID:'taile',id:'cx/gpt-6.1-sol',variant:'medium'}}]);
});
test('phục hồi team partial không ghi đè model đã chọn của session cũ',async()=>{
  const {room}=fake();let changes=0;
  await room.write(directory,{status:'partial',members:{admin:{role:'admin',sessionID:'s-admin',assigned:false}},messages:[],modelDefaults:{admin:{providerID:'p',id:'default'}}});
  room.ctx.session.get=async()=>({model:{providerID:'p',id:'user-choice'}});
  room.ctx.session.switchModel=async()=>{changes++};
  assert.equal((await room.create(directory)).status,'ready');assert.equal(changes,0);
});
test('tin nhắn chuyển tới đúng session và không giả lập phản hồi', async()=>{
  const {room,calls,transcripts}=fake();
  await room.create(directory);
  await room.send(directory,'owner','backend','Tạo API');
  assert.ok(calls.find(x=>x.sessionID==='s-backend' && x.text?.includes('Tạo API')));
  let snap=await room.sync(directory);
  assert.equal(snap.messages.filter(m=>m.status==='answered').length,0);
  transcripts.get('s-backend').push({id:'msg-1',type:'assistant',content:[{type:'text',text:'API thực tế đã tạo.'}]},{id:'idle-1',type:'idle',outcome:'succeeded'});
  snap=await room.sync(directory);
  assert.equal(snap.messages.at(-1).text,'API thực tế đã tạo.');
  assert.equal((await room.sync(directory)).messages.length,snap.messages.length);
});
test('agent gửi tới agent dựa trên sessionID thật, chống giả mạo',async()=>{
  const {room,calls}=fake();await room.create(directory);
  await room.sendAsSession(directory,'s-backend','frontend','Cần API contract');
  assert.ok(calls.some(x=>x.sessionID==='s-frontend'));
  await assert.rejects(()=>room.sendAsSession(directory,'s-fake','frontend','hello'),/không nằm/);
});
test('phát hiện agent còn thiếu, không tạo session rỗng',async()=>{
  const {room}=fake();
  room.ctx.agent.list=async()=>({data:[{id:'admin'}]});
  await assert.rejects(()=>room.create(directory),/chưa nạp agent/);
});
test('chỉ chấp nhận assistant có text thật',()=>{
  assert.equal(extractAssistant({data:[{id:'1',type:'user',parts:[{type:'text',text:'a'}]}]}),null);
  assert.deepEqual(extractAssistant({data:[{id:'a',type:'assistant',parts:[{type:'text',text:'b'}]}]}),{id:'a',text:'b',index:0});
});

test('không nhận phản hồi cũ; việc thứ hai chờ FIFO đến khi việc đầu hoàn tất',async()=>{
  const {room,transcripts}=fake(); await room.create(directory);
  transcripts.set('s-backend',[{id:'old',type:'assistant',parts:[{type:'text',text:'Xin chào cũ'}]}]);
  await room.send(directory,'owner','backend','Tạo API');
    const waiting=await room.send(directory,'owner','backend','Việc tiếp');
    assert.equal((await room.read(directory)).messages.find(m=>m.id===waiting).status,'waiting');
  let team=await room.sync(directory);
  assert.equal(team.messages.some(x=>x.text==='Xin chào cũ'&&x.status==='answered'),false);
  transcripts.get('s-backend').push({id:'new',type:'assistant',content:[{type:'text',text:'Đã xong API'}]},{id:'idle',type:'idle',outcome:'succeeded'});
  team=await room.sync(directory);
    assert.ok(team.messages.some(m=>m.text==='Đã xong API'&&m.status==='answered'));
    assert.equal(team.messages.find(m=>m.id===waiting).status,'admitted');
});
test('FIFO phục hồi qua room mới, sync đồng thời không dispatch trùng, giới hạn queue',async()=>{
  const {room,calls,transcripts}=fake();await room.create(directory);
  await room.send(directory,'owner','backend','first');
  const second=await room.send(directory,'owner','backend','second');
  for(let i=0;i<19;i++)await room.send(directory,'owner','backend',`waiting ${i}`);
  await assert.rejects(()=>room.send(directory,'owner','backend','overflow'),/Queue đầy/);
  transcripts.get('s-backend').push({id:'answer',type:'assistant',content:[{type:'text',text:'done'}]},{id:'idle',type:'idle',outcome:'succeeded'});
  const reopened=new TeamRoom(room.ctx);
  await Promise.all([reopened.sync(directory),reopened.sync(directory)]);
  assert.equal(calls.filter(c=>c.text?.includes('\nsecond\n')).length,1);
  assert.equal((await reopened.read(directory)).messages.find(m=>m.id===second).status,'admitted');
});

test('tạo session không nhận là thành công khi switchAgent thất bại',async()=>{
  const {room}=fake();
  room.ctx.session.switchAgent=async()=>{throw new Error('Not supported')};
  await assert.rejects(()=>room.create(directory),/Not supported/);
  assert.equal((await room.snapshot(directory)).status,'partial');
});

test('retry switchAgent giữ ID session đã tạo',async()=>{
  const {room,calls}=fake();const assign=room.ctx.session.switchAgent;
  room.ctx.session.switchAgent=async()=>{throw new Error('offline')};
  await assert.rejects(()=>room.create(directory),/offline/);
  room.ctx.session.switchAgent=assign;
  await room.create(directory);
  assert.equal(calls.filter(x=>x.title).length,5);
});

test('không nhận text streaming hoặc assistant sau prompt khác',async()=>{
  const {room,transcripts}=fake();await room.create(directory);await room.send(directory,'owner','qa','Review');
  const rows=transcripts.get('s-qa');
  rows.push({id:'partial',type:'assistant',content:[{type:'text',text:'Đang xem'}]});
  assert.equal((await room.sync(directory)).messages.at(-1).status,'admitted');
  rows.push({id:'external',type:'user',text:'Other request'},{id:'other-answer',type:'assistant',content:[{type:'text',text:'Không thuộc request'}]},{id:'idle',type:'idle',outcome:'succeeded'});
  assert.equal((await room.sync(directory)).messages.at(-1).status,'admitted');
});

test('timeout giữ uncertain, phục hồi từ transcript không gửi lại',async()=>{
  const {room,transcripts}=fake();await room.create(directory);await room.send(directory,'owner','backend','Review');
  const team=await room.read(directory);team.messages.at(-1).dispatchedAt='2000-01-01T00:00:00.000Z';await room.write(directory,team);
  assert.equal((await room.sync(directory)).messages.at(-1).status,'uncertain');
  const waiting=await room.send(directory,'owner','backend','Retry');
  assert.equal((await room.read(directory)).messages.find(m=>m.id===waiting).status,'waiting');
  transcripts.get('s-backend').push({id:'late',type:'assistant',content:[{type:'text',text:'Late reply'}]},{id:'idle',type:'idle',outcome:'succeeded'});
  const reopened=new TeamRoom(room.ctx);
  assert.ok((await reopened.sync(directory)).messages.some(m=>m.text==='Late reply'&&m.status==='answered'));
});

test('không có worktree thì cấm edit và shell',async()=>{
  const {room}=fake();const updates=[];
  room.ctx.worktree={create:async()=>{throw new Error('No Git HEAD')}};
  room.ctx.location={project:{id:'project'}};
  room.ctx.session.update=async input=>updates.push(input);
  await room.create(directory);
  assert.equal(updates.length,5);
  assert.ok(updates.every(x=>x.permissions.some(p=>p.action==='edit'&&p.effect==='deny')&&x.permissions.some(p=>p.action==='shell'&&p.effect==='deny')));
});

test('giới hạn hop chặn chuỗi hỏi AI vô hạn',async()=>{
  const {room}=fake();await room.create(directory);
  const team=await room.read(directory);team.messages.push({id:'parent',from:'admin',to:'backend',status:'admitted',hops:4});await room.write(directory,team);
  await assert.rejects(()=>room.sendAsSession(directory,'s-backend','frontend','forward'),/4 lần/);
});

test('idle interrupted hoặc failed kết thúc request, không nhận text dở là phản hồi',async()=>{
  for(const outcome of ['interrupted','failed']) {
    const {room,transcripts}=fake();await room.create(directory);
    const id=await room.send(directory,'owner','backend','Review');
    transcripts.get('s-backend').push({id:'partial',type:'assistant',content:[{type:'text',text:'Chưa xong'}]},{id:'idle',type:'idle',outcome});
    const team=await room.sync(directory);
    assert.equal(team.messages.find(m=>m.id===id).status,'error');
    assert.equal(team.messages.some(m=>m.sourceMessageID),false);
    await room.send(directory,'owner','backend','Lượt mới');
  }
});

test('session trong worktree vẫn gửi bằng room gốc sau phục hồi',async()=>{
  const {room,calls}=fake();room.ctx.location={project:{id:'project'}};
  room.ctx.worktree={create:async({name})=>({directory:`/tmp/worktrees/${name}`})};
  room.ctx.session.move=async input=>calls.push({move:input});
  const team=await room.create(directory);
  assert.ok(Object.values(team.members).every(m=>m.directory.startsWith('/tmp/worktrees/')));
  const reopened=new TeamRoom(room.ctx);
  await reopened.sendAsSession(directory,'s-admin','backend','Kiểm tra routing');
  assert.ok(calls.some(x=>x.sessionID==='s-backend'&&x.text?.includes('Kiểm tra routing')));
  await assert.rejects(()=>reopened.sendAsSession(team.members.admin.directory,'s-admin','qa','Sai room'),/không nằm/);
});

test('sync không tự sửa metadata session cũ, từ chối thiếu liên kết hoặc room khác',async()=>{
  const {room}=fake();await room.create(directory);const sessions=new Map();
  room.ctx.session.get=async({sessionID})=>sessions.get(sessionID)??{metadata:{keep:'existing'}};
  room.ctx.session.update=async({sessionID,metadata})=>sessions.set(sessionID,{metadata});
  await assert.rejects(()=>room.sync(directory),/thiếu liên kết/);
  assert.equal(sessions.size,0);
  for(const role of ['admin','frontend','backend','devops','qa'])sessions.set('s-'+role,{metadata:{teamDirectory:directory}});
  await room.sync(directory);
  sessions.get('s-admin').metadata.teamDirectory='/other';
  await assert.rejects(()=>room.sync(directory),/room khác/);
});
test('scheduler giới hạn worker, FIFO role, dependency và lỗi dispatch không dừng role khác',async()=>{
  const {room,transcripts}=fake();await room.create(directory);
  await room.configure(directory,{maxWorkers:2,providerLimits:{unknown:2}});
  await Promise.all(['frontend','backend','devops','qa'].map(r=>room.send(directory,'owner',r,r)));
  let team=await room.read(directory);
  assert.equal(team.messages.filter(m=>m.status==='admitted').length,2);
  assert.equal(team.messages.filter(m=>m.status==='waiting').length,2);
  for(const m of team.messages.filter(m=>m.status==='admitted'))transcripts.get(`s-${m.to}`).push({id:`a-${m.to}`,type:'assistant',content:[{type:'text',text:'done'}]},{type:'idle',outcome:'succeeded'});
  team=await room.sync(directory);assert.equal(team.messages.filter(m=>m.status==='admitted').length,2);
  await assert.rejects(()=>room.configure(directory,{maxWorkers:0}),/Concurrency/);
  const dep=fake().room;await dep.create(directory);
  const waitingTeam=await dep.read(directory);waitingTeam.tasks=[{id:'prerequisite',status:'working'},{id:'dependent',dependencies:['prerequisite']}];await dep.write(directory,waitingTeam);
  const dependent=await dep.send(directory,'owner','qa','dependency',{taskID:'dependent'});
  assert.equal((await dep.read(directory)).messages.find(m=>m.id===dependent).executionState,'Waiting for Dependency');
  const ready=await dep.read(directory);ready.tasks[0].status='done';await dep.write(directory,ready);await dep.drain(directory);
  assert.equal((await dep.read(directory)).messages.find(m=>m.id===dependent).status,'admitted');
  const another=fake().room;await another.create(directory);
  another.ctx.session.prompt=async o=>{if(o.sessionID==='s-backend')throw new Error('offline');return {id:o.id}};
  await Promise.all(['backend','frontend'].map(r=>another.send(directory,'owner',r,r)));
  team=await another.read(directory);assert.equal(team.messages.find(m=>m.to==='backend').status,'uncertain');assert.equal(team.messages.find(m=>m.to==='frontend').status,'admitted');
});
