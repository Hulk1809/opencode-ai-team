import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queueMessages} from '../src/peer-delivery.mjs';
import {OfficialCoordinator} from '../src/official-coordinator.mjs';

test('native dispatch persists uncertain delivery and never retries after lost response',async()=>{
  let calls=0;
  const state={mode:'peer',status:'ready',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[{id:'peer-1',sessionID:'ses_1',agent:'build',directory:'/project'}],messages:[{id:'message',from:'owner',to:'peer-1',action:'send',text:'hello',at:new Date(100).toISOString()}]};
  const c=Object.create(OfficialCoordinator.prototype);c.read=()=>state;c.mutate=fn=>fn(state).value;
  c.ctx={session:{get:async()=>({id:'ses_1',projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls++;assert.equal(input.delivery,'queue');assert.equal(state.deliveries[0].status,'submitting');throw Error('response lost');}}};
  await c.dispatchMessages();assert.equal(state.deliveries[0].status,'uncertain');
  await c.dispatchMessages();assert.equal(calls,1);
});

test('Owner pause prevents dispatch; native receipt marks sent',async()=>{
  let calls=0;
  const state={mode:'peer',teamID:'team',projectID:'project',collaboration:{enabled:true,enabledAt:0},members:[{id:'peer-1',sessionID:'ses_1',agent:'build',directory:'/project'}],messages:[{id:'message',from:'owner',to:'peer-1',action:'send',text:'hello',at:new Date(100).toISOString()}]};
  const c=Object.create(OfficialCoordinator.prototype);c.read=()=>state;c.mutate=fn=>fn(state).value;
  c.ctx={session:{get:async()=>({id:'ses_1',projectID:'project',agent:'build',location:{directory:'/project'}}),prompt:async input=>{calls++;return {id:input.id};}}};
  state.collaboration.enabled=false;await c.dispatchMessages();assert.equal(calls,0);
  state.collaboration.enabled=true;await c.dispatchMessages();assert.equal(calls,1);assert.equal(state.deliveries[0].status,'sent');
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
