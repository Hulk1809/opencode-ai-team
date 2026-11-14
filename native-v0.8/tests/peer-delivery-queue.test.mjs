import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queueMessages,queueTaskHandoffs,inbox,acknowledge} from '../src/peer-delivery.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';

test('native dispatch persists uncertain delivery and never retries after lost response',async()=>{
  let calls=0;
  const state={mode:'peer',status:'ready',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[{id:'peer-1',sessionID:'ses_1',agent:'build',directory:'/project'}],messages:[{id:'message',from:'owner',to:'peer-1',action:'send',text:'hello',at:new Date(100).toISOString()}]};
  const c=Object.create(OfficialCoordinator.prototype);c.read=()=>state;c.mutate=fn=>fn(state).value;
  c.ctx={session:{get:async()=>({id:'ses_1',projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls++;assert.equal(input.delivery,'queue');assert.equal(state.deliveries[0].status,'submitting');throw Error('response lost');}}};
  await c.dispatchMessages();assert.equal(state.deliveries[0].status,'uncertain');
  await c.dispatchMessages();assert.equal(calls,1);
});

test('task handoffs target reviewer, rework owner and dependency-ready worker, never team',()=>{
  const members=[1,2,3,4].map(n=>({id:`peer-${n}`,sessionID:`ses_${n}`}));
  const a={id:'a',protocolVersion:1,planID:'plan',planVersion:1,taskVersion:4,status:'SUBMITTED',assignee:'peer-1',reviewer:'peer-2',dependencies:[]};
  const b={...a,id:'b',status:'RUNNING',assignee:'peer-3'};
  const qa={...a,id:'qa',status:'READY',assignee:'unclaimed',assignedPeer:'peer-4',dependencies:['a','b']};
  const state={mode:'peer',teamID:'team',collaboration:{enabled:true,enabledAt:0},members,tasks:[a,b,qa],messages:[]};
  queueTaskHandoffs(state,'peer-1','submit',a,100);
  assert.deepEqual(state.messages.map(m=>m.to),['peer-2']);
  a.status='REVIEW';queueTaskHandoffs(state,'peer-2','review',a,101);
  assert.equal(state.messages.length,1);
  a.status='REWORK';a.taskVersion++;queueTaskHandoffs(state,'peer-2','review',a,102);
  assert.equal(state.messages.at(-1).to,'peer-1');
  a.status='DONE';a.taskVersion++;queueTaskHandoffs(state,'peer-2','done',a,103);
  assert.equal(state.messages.length,2); // QA still waits for b.
  b.status='DONE';queueTaskHandoffs(state,'peer-1','done',b,104);
  queueTaskHandoffs(state,'peer-1','done',b,104);
  assert.equal(state.messages.length,3);assert.equal(state.messages.at(-1).to,'peer-4');
  assert.equal(state.messages.at(-1).taskID,'qa');
  queueMessages(state);assert.deepEqual(state.deliveries.map(d=>d.memberID),['peer-2','peer-1','peer-4']);
  assert.ok(state.messages.every(m=>m.to!=='team'));
});

test('tagged recipients can read and acknowledge message without granting unrelated peers access',()=>{
  const state={members:[1,2,3,4].map(n=>({id:`peer-${n}`,sessionID:`ses_${n}`})),messages:[{id:'tag',from:'peer-1',to:'peer-2',text:'Ask @peer-3',action:'send'}]};
  assert.equal(inbox(state,state.members[2]).length,1);
  assert.equal(acknowledge(state,state.members[2],{messageID:'tag',requestID:'receipt'}).memberID,'peer-3');
  assert.equal(inbox(state,state.members[3]).length,0);
  assert.throws(()=>acknowledge(state,state.members[3],{messageID:'tag',requestID:'forbidden'}),/PEER_MESSAGE_FORBIDDEN/);
});

test('Owner pause prevents dispatch; native receipt marks sent',async()=>{
  let calls=0;
  const state={mode:'peer',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[{id:'peer-1',sessionID:'ses_1',agent:'build',directory:'/project'}],messages:[{id:'message',from:'owner',to:'peer-1',action:'send',text:'hello',at:new Date(100).toISOString()}]};
  const c=Object.create(OfficialCoordinator.prototype);c.read=()=>state;c.mutate=fn=>fn(state).value;
  c.ctx={session:{get:async()=>({id:'ses_1',projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls++;return {id:input.id};}}};
  state.collaboration.enabled=false;await c.dispatchMessages();assert.equal(calls,0);
  state.collaboration.enabled=true;await c.dispatchMessages();assert.equal(calls,1);assert.equal(state.deliveries[0].status,'sent');
});

test('directed messages reach only selected native session without receipt gating',async()=>{
  const state={mode:'peer',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[1,2].map(n=>({id:`peer-${n}`,sessionID:`ses_${n}`,agent:'build',directory:'/project'})),messages:[],receipts:[]};
  for(let i=0;i<5;i++)state.messages.push({id:`message-${i}`,from:'owner',to:'peer-1',action:'send',text:'work',at:new Date(100+i).toISOString()});
  state.messages.push({id:'other',from:'owner',to:'peer-2',action:'send',text:'other work',at:new Date(110).toISOString()});
  const calls=[],c=Object.create(OfficialCoordinator.prototype);c.read=()=>state;c.mutate=fn=>fn(state).value;
  c.ctx={session:{get:async({sessionID})=>({id:sessionID,projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls.push(input);return {id:input.id};}}};
  await c.dispatchMessages();await c.dispatchMessages();
  assert.deepEqual(calls.map(c=>c.sessionID),['ses_1','ses_1','ses_1','ses_1','ses_1','ses_2']);
  assert.ok(calls.slice(0,5).every(c=>!c.text.includes('other work')));
  assert.ok(calls[5].text.includes('other work'));
  assert.equal(state.deliveries.filter(d=>d.status==='queued').length,0);
});

test('concurrent coordinators dispatch each directed message once',async()=>{
  const state={mode:'peer',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[{id:'peer-1',sessionID:'ses_1',agent:'build',directory:'/project'}],messages:[0,1].map(i=>({id:`m${i}`,from:'owner',to:'peer-1',action:'send',text:'work',at:new Date(100+i).toISOString()}))};
  let calls=0;
  const make=()=>{
    const c=Object.create(OfficialCoordinator.prototype);c.read=()=>structuredClone(state);c.mutate=fn=>fn(state).value;
    c.ctx={session:{get:async()=>({id:'ses_1',projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls++;return {id:input.id};}}};
    return c;
  };
  await Promise.all([make().dispatchMessages(),make().dispatchMessages()]);
  assert.equal(calls,2);assert.deepEqual(state.deliveries.map(d=>d.status),['sent','sent']);
});

test('dispatch opt-in, no historical replay, tag dedup, broadcast excludes sender',()=>{
  const state={mode:'peer',teamID:'team',members:[1,2,3,4].map(n=>({id:`peer-${n}`,sessionID:`ses_${n}`})),messages:[{id:'old',from:'owner',to:'team',action:'send',text:'old',at:new Date(10).toISOString()}]};
  queueMessages(state);assert.equal(state.deliveries,undefined);
  state.collaboration={enabled:true,enabledAt:20};queueMessages(state);assert.equal(state.deliveries.length,0);
  state.messages.push({id:'tag',from:'peer-1',to:'peer-2',action:'send',text:'@peer-2 @peer-3 @peer-3',at:new Date(30).toISOString()});
  queueMessages(state);queueMessages(state);assert.deepEqual(state.deliveries.map(d=>d.memberID),['peer-2','peer-3']);
  state.messages.push({id:'all',from:'peer-1',to:'team',action:'send',text:'team',at:new Date(40).toISOString()});queueMessages(state);
  assert.equal(state.deliveries.length,5);assert.equal(new Set(state.deliveries.map(d=>d.promptID)).size,5);
  state.collaboration.enabled=false;state.messages.push({id:'paused',from:'owner',to:'team',action:'send',text:'pause',at:new Date(50).toISOString()});queueMessages(state);assert.equal(state.deliveries.length,5);
});
