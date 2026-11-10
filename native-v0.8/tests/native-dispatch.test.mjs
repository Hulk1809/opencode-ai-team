import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TeamRoom} from '../src/room.mjs';
import {dispatchDiscussion,reconcileDiscussion} from '../src/native-dispatch.mjs';

test('native dispatch journals stable identity, fences and never resends uncertain admission',async()=>{
  const directory='/disposable',key=`teams/${encodeURIComponent(directory)}`;
  let values=new Map(),calls=0,ambiguous=false,history=[];
  const ctx={location:{project:{id:'project'}},storage:{
    get:async key=>structuredClone(values.get(key)),
    transaction:async work=>{const next=structuredClone(values);const result=work({get:key=>next.get(key),set:(key,value)=>{next.set(key,value);}});values=next;return result;},
  },session:{
    get:async({sessionID})=>({id:sessionID,projectID:'project',agent:'frontend',location:{directory:'/frontend'}}),
    prompt:async input=>{calls++;assert.equal(values.get(key).messages.find(m=>m.promptID===input.id).status,'submitting');history.push({id:input.id,type:'user'});if(ambiguous)throw Error('response lost');return {id:input.id};},
    context:async()=>history,
  }};
  const claims=new WeakSet();
  ctx.canonical={recipient:async()=>({valid:async()=>true,
    claim:async({scope,owner,id})=>{assert.equal(scope,directory);assert.deepEqual(owner,values.get(key).owner);assert.equal(values.get(key).messages.find(m=>m.promptID===id).status,'submitting');const claim={};claims.add(claim);return claim;},
    prompt:input=>{assert.ok(claims.has(input.claim));return ctx.session.prompt(input);}})};
  values.set(key,{directory,projectID:'project',status:'ready',messages:[],members:{backend:{sessionID:'backend'},frontend:{sessionID:'frontend',directory:'/frontend'}}});
  const room=new TeamRoom(ctx),owner=await room.takeOwnership(directory,'owner',0);
  const add=async key=>{const id=await room.enqueueDiscussion(directory,owner,'backend','frontend','hello',key);values.get(`teams/${encodeURIComponent(directory)}`).messages.find(m=>m.id===id).recipientSessionID='frontend';return id;};
  const id=await add('first');
  const ready=ctx.canonical.recipient;
  ctx.canonical.recipient=async()=>undefined;
  assert.equal((await dispatchDiscussion(ctx,room,directory,owner,'frontend',new AbortController().signal)).status,'not-ready');
  assert.equal(values.get(key).messages[0].status,'queued');assert.equal(calls,0);
  ctx.canonical.recipient=ready;
  const first=await dispatchDiscussion(ctx,room,directory,owner,'frontend',new AbortController().signal);
  assert.equal(first.id,id);assert.equal(first.status,'admitted');assert.equal(calls,1);
  // Admitted recipient blocks a second concurrent request until completion is observed.
  values.get(key).messages[0].status='answered';
  history.push({id:'first_terminal',type:'idle',outcome:'succeeded'});
  const second=await add('second');ambiguous=true;
  assert.equal((await dispatchDiscussion(ctx,room,directory,owner,'frontend',new AbortController().signal)).status,'uncertain');
  assert.equal((await dispatchDiscussion(ctx,room,directory,owner,'frontend',new AbortController().signal)).status,'idle');
  assert.equal(calls,2);
  const saved=history;history=[];
  assert.equal((await reconcileDiscussion(ctx,room,directory,owner,second)).status,'uncertain');assert.equal(calls,2);
  history=saved;
  const replacement=await room.takeOwnership(directory,'next',owner.generation);
  await assert.rejects(reconcileDiscussion(ctx,room,directory,owner,second),/STALE_ROOM_OWNER/);
  assert.equal((await reconcileDiscussion(ctx,room,directory,replacement,second)).status,'processing');
  assert.equal(calls,2);
  history.push({id:'assistant',type:'assistant',content:[{type:'text',text:'reply'}]},{id:'terminal',type:'idle',outcome:'succeeded'});
  assert.equal((await reconcileDiscussion(ctx,room,directory,replacement,second)).status,'completed');
  await reconcileDiscussion(ctx,room,directory,replacement,second);
  assert.equal((await room.read(directory)).messages.filter(m=>m.requestID===second).length,1);
  // Missing patched authority must remain fail-closed, even when recipient reports ready.
  const third=await room.enqueueDiscussion(directory,replacement,'backend','frontend','hello','missing-claim');
  values.get(key).messages.find(m=>m.id===third).recipientSessionID='frontend';
  ctx.canonical.recipient=async()=>({valid:async()=>true,prompt:input=>ctx.session.prompt(input)});
  const before=calls;
  assert.equal((await dispatchDiscussion(ctx,room,directory,replacement,'frontend',new AbortController().signal)).status,'uncertain');
  assert.equal(calls,before);
  assert.equal((await room.read(directory)).messages.find(m=>m.id===third).status,'uncertain');
});

test('durable inbox retrieves old responses with scoped keyset cursor and request filter',()=>{
  const room=new TeamRoom({});
  const team={messages:Array.from({length:30},(_,i)=>({id:`response_${i}`,requestID:`request_${i}`,to:'backend'}))};
  team.messages.push({id:'private',requestID:'request_0',to:'frontend'});
  const page=room.discussionInbox(team,'backend');
  assert.equal(page.messages.length,24);assert.equal(page.before,'response_6');
  assert.deepEqual(room.discussionInbox(team,'backend',{before:page.before}).messages,team.messages.slice(0,6));
  assert.deepEqual(room.discussionInbox(team,'backend',{requestID:'request_0'}).messages,[team.messages[0]]);
  assert.throws(()=>room.discussionInbox(team,'backend',{before:'private'}),/INBOX_CURSOR_NOT_FOUND/);
  assert.throws(()=>room.discussionInbox(team,'backend',{limit:101}),/INVALID_INBOX_QUERY/);
});

test('recipient reservations isolate uncertain work and enforce total cap three',async()=>{
  let state={status:'ready',owner:{id:'owner',generation:1},members:{frontend:{sessionID:'front'},backend:{sessionID:'back'},qa:{sessionID:'qa'},devops:{sessionID:'devops'}},messages:[{id:'uncertain',to:'frontend',recipientSessionID:'front',status:'uncertain'},...['frontend','backend','qa','devops'].map(to=>({id:to,to,recipientSessionID:{frontend:'front',backend:'back',qa:'qa',devops:'devops'}[to],status:'queued'}))]};
  const room=new TeamRoom({storage:{transaction:async work=>work({get:()=>state,set:(_key,value)=>{state=value;}})}});
  assert.equal(await room.claimDiscussion('/room',state.owner,'frontend'),null);
  assert.equal((await room.claimDiscussion('/room',state.owner,'backend')).status,'claimed');
  assert.equal((await room.claimDiscussion('/room',state.owner,'qa')).status,'claimed');
  assert.equal(await room.claimDiscussion('/room',state.owner,'devops'),null);
  await assert.rejects(room.claimDiscussion('/room',{id:'stale',generation:0},'backend'),/STALE_ROOM_OWNER/);
  assert.equal(state.messages[0].status,'uncertain');
});

test('reconciliation rejects merged prefix, truncated history, idle-only and unknown outcome',async()=>{
  const directory='/disposable';
  for(const [rows,reason] of [
    [[{type:'user',id:'other'},{type:'user',id:'request'},{type:'assistant',id:'assistant'},{type:'idle',id:'terminal',outcome:'succeeded'}],'MERGED_INPUT_BEFORE_REQUEST'],
    [[{type:'assistant',id:'assistant'},{type:'idle',id:'terminal',outcome:'succeeded'}],'NO_CORRELATED_HOST_CONTEXT'],
    [[{type:'user',id:'request'},{type:'idle',id:'terminal',outcome:'succeeded'}],'AMBIGUOUS_TURN'],
    [[{type:'user',id:'request'},{type:'assistant',id:'assistant'},{type:'idle',id:'terminal',outcome:'unknown'}],'AMBIGUOUS_TURN'],
    [[{type:'user',id:'request'},{type:'assistant',id:'assistant'},{type:'idle',id:'terminal',outcome:'interrupted'}],'HOST_TURN_INTERRUPTED'],
  ]){
    let state={directory,projectID:'project',status:'ready',owner:{id:'owner',generation:1},members:{frontend:{sessionID:'frontend',directory:'/frontend'}},messages:[{id:'queue',to:'frontend',status:'uncertain',submission:{sessionID:'frontend',requestID:'request'}}]};
    const ctx={location:{project:{id:'project'}},session:{get:async()=>({id:'frontend',projectID:'project',agent:'frontend',location:{directory:'/frontend'}}),context:async()=>rows},storage:{get:async()=>structuredClone(state),transaction:async work=>work({get:()=>state,set:(_key,value)=>{state=value;}})}};
    const room=new TeamRoom(ctx);
    assert.equal((await reconcileDiscussion(ctx,room,directory,state.owner,'queue')).status,'uncertain');
    assert.equal(state.messages[0].reconciliation.reason,reason);
    assert.equal(state.messages.length,1);
  }
});

test('claimed-only takeover requeues; journaled takeover stays uncertain and stale owner cannot write',async()=>{
  const directory='/disposable',key=`teams/${encodeURIComponent(directory)}`;
  let state={directory,status:'ready',messages:[{id:'claimed',status:'claimed',ownerGeneration:1},{id:'journaled',status:'submitting',ownerGeneration:1,submission:{requestID:'prompt',sessionID:'frontend'}}],owner:{id:'old',generation:1}};
  const room=new TeamRoom({storage:{get:async()=>structuredClone(state),transaction:async work=>{const next=structuredClone(state);const result=work({get:()=>next,set:(_key,value)=>{state=value;}});return result;}}});
  const owner=await room.takeOwnership(directory,'new',1);
  assert.equal(state.messages[0].status,'queued');
  assert.equal(state.messages[1].status,'uncertain');
  assert.deepEqual(state.messages[1].submission,{requestID:'prompt',sessionID:'frontend'});
  await assert.rejects(room.recordDispatchEvidence(directory,{id:'old',generation:1},'journaled','processing',{requestID:'prompt',sessionID:'frontend',userID:'prompt'}),/STALE_ROOM_OWNER/);
  await room.recordDispatchEvidence(directory,owner,'journaled','processing',{requestID:'prompt',sessionID:'frontend',userID:'prompt'});
  assert.equal(state.messages[1].status,'processing');
});
