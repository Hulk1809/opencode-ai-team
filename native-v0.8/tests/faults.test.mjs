import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {TeamRoom,rateLimitDecision} from '../src/room.mjs';

test('controlled HTTP 429/400 and transport timeout preserve uncertain admission until durable recovery',async()=>{
  const server=createServer((req,res)=>{
    if(req.url==='/timeout')return; // Accepted connection, deliberately no response.
    res.writeHead(req.url==='/429'?429:400,{'Retry-After':'2'});res.end('controlled fault');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,storage=new Map(),rows=[],calls=[];
  const ctx={storage:{get:async k=>structuredClone(storage.get(k)),set:async(k,v)=>storage.set(k,structuredClone(v))},session:{context:async()=>rows,prompt:async p=>{calls.push(p);await fetch(`${base}/timeout`,{signal:AbortSignal.timeout(50)});}}};
  try{
    const limited=await fetch(`${base}/429`);await limited.text();assert.deepEqual(rateLimitDecision({status:limited.status,retryAfterMs:Number(limited.headers.get('Retry-After'))*1000},0),{retry:true,delay:2000});
    const invalid=await fetch(`${base}/400`);await invalid.text();assert.equal(rateLimitDecision({status:invalid.status},0),undefined);
    const room=new TeamRoom(ctx),directory='/controlled-fault';
    await room.write(directory,{status:'ready',members:{qa:{role:'qa',sessionID:'qa'}},tasks:[{id:'t',status:'working',dependencies:[]}],files:[{id:'f',checksum:'preserved'}],messages:[]});
    const id=await room.send(directory,'owner','qa','timeout admission',{taskID:'t'});
    let state=await room.read(directory);const request=state.messages.find(m=>m.id===id);assert.equal(request.status,'uncertain');assert.equal(calls.length,1);
    // Admission may have succeeded before transport failed; reconcile, never replay.
    rows.push({id:request.promptID,type:'user'},{id:'assistant',type:'assistant',content:[{type:'text',text:'recovered'}]},{id:'idle',type:'idle',outcome:'succeeded'});
    state=await new TeamRoom(ctx).sync(directory);assert.equal(state.messages.find(m=>m.id===id).status,'answered');assert.equal(calls.length,1);assert.equal(state.tasks[0].id,'t');assert.equal(state.files[0].checksum,'preserved');
    const failedID=await new TeamRoom(ctx).send(directory,'owner','qa','session failure',{taskID:'t'});
    state=await room.read(directory);const failed=state.messages.find(m=>m.id===failedID);
    rows.push({id:failed.promptID,type:'user'},{id:'failed-idle',type:'idle',outcome:'failed',error:{message:'controlled session failure'}});
    state=await new TeamRoom(ctx).sync(directory);assert.equal(state.messages.find(m=>m.id===failedID).status,'error');assert.equal(calls.length,2);assert.equal(state.messages.find(m=>m.id===id).status,'answered');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
