import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFile, TeamFiles } from '../src/files.mjs';
import { Workspace } from '../src/workspace.mjs';
import { TeamRoom } from '../src/room.mjs';
import { redact, errorText } from '../src/safety.mjs';
const input=(text,name='requirements.md')=>({name,base64:Buffer.from(text).toString('base64'),mime:'text/plain'});
test('Team Shared is explicit and project-local; private/restricted survive, diff and AWS secret guards',async()=>{
  const {ctx,room,workspace}=setup();const members=Object.fromEntries(['admin','backend','frontend','devops','qa'].map(role=>[role,{role,sessionID:role}]));
  await room.write('/project',{status:'ready',members,messages:[]});
  const files=new TeamFiles(ctx),privateFile=await workspace.execute('/project','backend','upload',input('private note'));
  await assert.rejects(files.read('/project','qa',privateFile.id),/quyền/);
  const shared=await workspace.execute('/project','backend','upload',{...input('diff --git a/A.java b/A.java\n+// benign change','change.diff'),visibility:'team',revision:'fixture-review-v1'});
  for(const role of Object.keys(members))assert.match((await workspace.execute('/project',role,'read',{fileID:shared.id})).text,/benign/);
  await assert.rejects(files.read('/other','qa',shared.id),/quyền/);
  await workspace.execute('/project','backend','share',{fileID:privateFile.id,recipient:'qa'});
  assert.equal((await files.read('/project','qa',privateFile.id)).file.visibility,'restricted');
  await assert.rejects(files.read('/project','frontend',privateFile.id),/quyền/);
  await assert.rejects(files.share('/project','qa',privateFile.id,'team'),/Chỉ/);
  await assert.rejects(files.upload('/project','backend',input('aws_secret_access_key=synthetic-test-not-real')),/credential/);
  await assert.rejects(files.upload('/project','backend',input('AKIA'+'Z'.repeat(16))),/credential/);
  await assert.rejects(files.upload('/project','backend',input('benign','credentials.md')),/nhạy cảm/);
  assert.ok((await room.read('/project')).fileEvents.some(e=>e.action==='read'&&e.project==='/project'));
});
test('protected coding mutation rejects legacy evidence and omitted caller without host policy',async()=>{
  const {room,workspace,rows}=setup();
  await room.write('/project',{status:'ready',members:{backend:{role:'backend',sessionID:'b',codingScope:{commands:['mvn -B test']}}},messages:[{id:'r',taskID:'t',to:'backend',status:'admitted'}],tasks:[{id:'t',createdAt:new Date(0).toISOString(),assignee:'backend',status:'todo',dependencies:[],outputAttachments:['artifact'],reviews:[],logs:[]}]});
  await assert.rejects(workspace.execute('/project','b','update',{taskID:'t',status:'working'}),/no legacy fallback/);
  let t=await room.read('/project');assert.equal(t.tasks[0].acknowledgedBy,undefined);
  await assert.rejects(workspace.execute('/project','b','update',{taskID:'t',status:'done',finalReport:'created file; tests PASS'}),/no legacy fallback/);
  rows.set('b',[{id:'a',type:'assistant',time:{created:Date.now()},content:[{type:'tool',id:'call',name:'shell',state:{input:{command:'mvn -B test'},metadata:{exit:0}}}]}]);
  await assert.rejects(workspace.execute('/project','b','update',{taskID:'t',status:'done'}),/no legacy fallback/);
  t=await room.read('/project');t.tasks[0].reviews.push({from:'qa',note:'independent evidence reviewed'});await room.write('/project',t);
  await assert.rejects(workspace.execute('/project',null,'update',{taskID:'t',status:'done'}),/no legacy fallback/);
  assert.equal((await room.read('/project')).tasks[0].status,'todo');
});
function setup(){const data=new Map();const rows=new Map();const ctx={storage:{get:async k=>structuredClone(data.get(k)),set:async(k,v)=>data.set(k,structuredClone(v))},session:{context:async({sessionID})=>rows.get(sessionID)??[],prompt:async({sessionID,id,text})=>{rows.set(sessionID,[{id,type:'user',text}]);return {id};}}};const room=new TeamRoom(ctx);return {ctx,room,rows,workspace:new Workspace(ctx,room)};}
test('legacy execution and restore cannot gain Owner authority from omitted session',async()=>{
  const {workspace}=setup();
  for(const action of ['approve_coding','approve_build','build','restore'])for(const sessionID of [undefined,'admin','backend'])await assert.rejects(workspace.execute('/project',sessionID,action,{}),/disabled until trusted host writer boundary/);
});
test('unknown task cannot unblock or complete through payload Owner identity',async()=>{
  const {room,workspace}=setup();await room.write('/project',{status:'ready',members:{admin:{role:'admin',sessionID:'a'}},messages:[],tasks:[{id:'t',status:'blocked',assignee:'qa',dependencies:['pending'],outputAttachments:[],reviews:[],logs:[]}]});
  await assert.rejects(workspace.execute('/project',null,'update',{taskID:'t',status:'working',note:'  '}),/no legacy fallback/);
  assert.equal((await room.read('/project')).tasks[0].status,'blocked');
  await assert.rejects(workspace.execute('/project',null,'update',{taskID:'t',status:'working',note:'Artifact shared: file-id; dependency retained'}),/no legacy fallback/);
  const task=(await room.read('/project')).tasks[0];assert.equal(task.status,'blocked');assert.deepEqual(task.dependencies,['pending']);
  await assert.rejects(workspace.execute('/project',null,'update',{taskID:'t',status:'done'}),/no legacy fallback/);
});
test('metadata-free task cannot use legacy direct DONE or manufacture completion event',async()=>{
  const {room,workspace}=setup();await room.write('/project',{status:'ready',members:{admin:{role:'admin',sessionID:'a'}},messages:[],tasks:[{id:'t',status:'working',assignee:'backend',dependencies:[],outputAttachments:['artifact-id'],reviews:[],logs:[]}]});
  for(const sessionID of [null,'a'])await assert.rejects(workspace.execute('/project',sessionID,'update',{taskID:'t',status:'done',finalReport:'test command exit 0'}),/no legacy fallback/);
  const team=await room.read('/project');assert.equal(team.messages.length,0);assert.equal(team.tasks[0].status,'working');
});
test('monitor phân biệt model kế thừa, selected và last used; không lộ settings',async()=>{
  const {ctx,room,rows,workspace}=setup();
  await room.write('/project',{status:'ready',members:{admin:{role:'admin',sessionID:'s'}},messages:[]});
  ctx.session.get=async()=>({});ctx.agent={get:async()=>({})};
  ctx.model={default:async()=>({location:{directory:'/project'},data:{providerID:'p',id:'flash',settings:{apiKey:'private'}}})};
  rows.set('s',[{type:'agent-switched'}]);
  const m=(await workspace.execute('/project',null,'monitor',{})).members[0];
  assert.deepEqual(m.effectiveModel,{providerID:'p',id:'flash'});assert.equal(m.selectedModel,null);assert.equal(m.model,null);assert.equal(m.state,'Idle');assert.ok(!JSON.stringify(m).includes('private'));
  ctx.session.get=async()=>({model:{providerID:'p',id:'selected',variant:undefined}});
  rows.set('s',[{type:'assistant',model:{providerID:'p',id:'used',variant:undefined,settings:{apiKey:'private'}}},{type:'idle',outcome:'succeeded'}]);
  const result=await workspace.execute('/project',null,'monitor',{});
  assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
  assert.deepEqual(result.members[0].model,{providerID:'p',id:'used'});
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('upload thật, checksum và chunk; từ chối extension, MIME và traversal',async()=>{
  const file=await decodeFile(...Object.values(input('Yêu cầu thật')));
  assert.equal(file.text,'Yêu cầu thật');assert.equal(file.checksum.length,64);
  for(const name of ['../x.md','bad.exe','.env'])await assert.rejects(()=>decodeFile(name,'YQ=='));
  await assert.rejects(()=>decodeFile('x.pdf','YQ==','application/pdf'),/khớp/);
  await assert.rejects(()=>decodeFile('x.md','YQ==','image/png'),/MIME/);
  await assert.rejects(()=>decodeFile('x.md','%%%'),/base64/);
});
test('monitor phân loại provider 400 không retry, RPC Unknown và health hồi phục',async()=>{
  const {ctx,room,rows,workspace}=setup();
  await room.write('/project',{status:'ready',members:{backend:{role:'backend',sessionID:'s'}},messages:[]});
  ctx.session.get=async()=>({model:{providerID:'p',id:'m'}});ctx.agent={get:async()=>({})};
  rows.set('s',[{type:'idle',outcome:'failed',error:{type:'provider.invalid-request',status:400,message:'INVALID_ARGUMENT'}}]);
  let member=(await workspace.execute('/project',null,'monitor',{})).members[0];
  assert.equal(member.health.error.kind,'provider');assert.equal(member.health.error.retryable,false);assert.equal(member.state,'Error');
  rows.set('s',[{type:'idle',outcome:'succeeded'}]);
  member=(await workspace.execute('/project',null,'monitor',{})).members[0];
  assert.equal(member.health.error,null);assert.equal(member.state,'Idle');
  ctx.session.get=async()=>{throw Error('RPC unavailable');};
  member=(await workspace.execute('/project',null,'monitor',{})).members[0];
  assert.equal(member.state,'Unknown');assert.equal(member.health.error.kind,'rpc');
});
test('file ACL theo project và role, phục hồi từ storage',async()=>{
  const {ctx}=setup();const files=new TeamFiles(ctx);const f=await files.upload('/project','owner',input('abcdef'));
  await assert.rejects(()=>files.read('/project','backend',f.id),/quyền/);
  await files.share('/project','owner',f.id,'backend');
  assert.equal((await new TeamFiles(ctx).read('/project','backend',f.id,1,3)).text,'bcd');
  await assert.rejects(()=>files.read('/other','backend',f.id),/quyền/);
  await assert.rejects(()=>files.read('/project','backend',f.id,-1),/Chunk/);
  await assert.rejects(()=>files.share('/project','backend',f.id,'qa'),/Chỉ/);
});
test('task mapping, blocker, artifact và dependency validation',async()=>{
  const {room,rows,workspace}=setup();await room.write('/p',{status:'ready',members:{admin:{sessionID:'a',role:'admin'},backend:{sessionID:'b',role:'backend'}},messages:[]});
  const f=await workspace.execute('/p',undefined,'upload',input('Làm API Java'));
  await workspace.execute('/p',undefined,'share',{fileID:f.id,recipient:'admin'});
  const task=await workspace.execute('/p','a','task',{title:'API',assignee:'backend',inputAttachments:[f.id],acceptanceCriteria:['Test pass']});
  assert.ok(task.messageID);assert.ok(rows.get('b')[0].text.includes(f.id));
  assert.equal((await workspace.execute('/p','b','read',{fileID:f.id})).text,'Làm API Java');
  await assert.rejects(workspace.execute('/p','b','blocker',{taskID:task.id,note:'Chưa có quyền'}),/no legacy fallback/);
  await assert.rejects(()=>workspace.execute('/p','b','task',{title:'X',assignee:'admin'}),/Chỉ/);
  const output=await workspace.execute('/p','b','upload',input('Báo cáo thật','report.md'));
  await workspace.execute('/p','b','artifact',{taskID:task.id,fileID:output.id});
  assert.equal((await workspace.execute('/p','a','read',{fileID:output.id})).text,'Báo cáo thật');
  const dependent=await workspace.execute('/p','a','task',{title:'Next',assignee:'backend',dependencies:[task.id]});
  await assert.rejects(()=>workspace.execute('/p','b','update',{taskID:dependent.id,status:'done'}),/no legacy fallback/);
});
test('redact token, structured errors; từ chối credential trong tài liệu',async()=>{
  const token='sk-'+'x'.repeat(24);
  assert.equal(redact(token),'[REDACTED]');
  assert.equal(errorText({data:{reason:'Agent bận'}}),'Agent bận');
  await assert.rejects(()=>decodeFile('secret.md',Buffer.from(token).toString('base64')),/credential/);
});
test('task lỗi không cấp ACL; chia sẻ đồng thời giữ đủ người nhận',async()=>{
  const {room,workspace}=setup();await room.write('/p',{status:'ready',members:{backend:{sessionID:'b',role:'backend'}},messages:[]});
  const file=await workspace.execute('/p',undefined,'upload',input('private'));
  for(const fields of [{dependencies:['missing']},{inputAttachments:[file.id,'missing']},{acceptanceCriteria:[{}]}]) {
    await assert.rejects(()=>workspace.execute('/p',undefined,'task',{title:'Invalid',assignee:'backend',inputAttachments:[file.id],...fields}));
    await assert.rejects(()=>workspace.execute('/p','b','read',{fileID:file.id}),/quyền/);
  }
  await Promise.all(['backend','qa','frontend'].map(recipient=>workspace.execute('/p',undefined,'share',{fileID:file.id,recipient})));
  const stored=await workspace.files.get('/p','owner',file.id);
  for(const role of ['backend','qa','frontend'])assert.ok(stored.acl.includes(role));
});
