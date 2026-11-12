import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as peers from '../src/peer-team.mjs';
import * as crypto from 'node:crypto';
import * as pilotModels from '../src/pilot-models.mjs';

function bridge(change=()=>{},response=1){
  const root=process.cwd(),calls=[];
  const window={isDestroyed:()=>false};
  const controller=new AbortController();
  const endpoint={id:'sidecar',url:'local-server',sameMachine:true};
  let impl;
  const ctx={windows:{get:()=>window},serverEndpoints:{get:()=>endpoint},
    client:{session:{get:async()=>({id:'session',projectID:'project',location:{directory:root}})},
      project:{list:async()=>[{id:'project',canonical:root}]},
       rpc:()=>({snapshot:async()=>({}),createTeam:async(input,options)=>calls.push({input,options}),ownerPlan:async(input,options)=>calls.push({input,options})})},
    provide:(_,value)=>{impl=value}};
  const modules={electron:{dialog:{showMessageBox:async()=>{await change({ctx,controller,endpoint});return {response}}}},
    'node:fs':{realpathSync:p=>p},'node:crypto':crypto,'./peer-team.mjs':peers,'./pilot-models.mjs':pilotModels,'./pilot-owner-ipc':{PilotOwner:{}},'./pilot-rpc':{PilotRPC:{}}};
  const exports={};
  const code=ts.transpileModule(readFileSync(new URL('../src/pilot-owner-main.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code,{exports,require:name=>{assert.ok(Object.hasOwn(modules,name));return modules[name]},Set,Error,JSON,Buffer});
  let issued=0,binding;
  exports.registerPilotOwner(ctx,scope=>{issued++;binding=scope;return 'private-capability'});
  return {run:()=>impl.authorizeCreate({sessionID:'session',directory:root},{window:1,signal:controller.signal}),publish:plan=>impl.publishPlan({sessionID:'session',directory:root,planJSON:JSON.stringify(plan)},{window:1,signal:controller.signal}),binding:()=>binding,calls,issued:()=>issued,ctx};
}

test('model selection without host Owner context never opens dialog or issues grant',async()=>{
  let dialogs=0;const b=bridge(()=>{dialogs++});
  await assert.rejects(b.publish({operation:'selectModel',requestID:'model'}),/authenticated Owner context/);
  assert.equal(dialogs,0);assert.equal(b.issued(),0);assert.equal(b.calls.length,0);
});

test('native approval sends capability main-to-server only; cancellation has no side effects',async()=>{
  const approved=bridge();
  assert.equal(await approved.run(),true);
  assert.equal(approved.issued(),1);assert.equal(approved.calls.length,1);
  assert.equal(approved.calls[0].input.authorization,'private-capability');
  const cancelled=bridge(()=>{},0);
  await assert.rejects(cancelled.run(),/PILOT_OWNER_CANCELLED/);
  assert.equal(cancelled.issued(),0);assert.equal(cancelled.calls.length,0);
});

test('Owner plan approval binds exact payload and request; cancellation cannot publish',async()=>{
  const plan={requestID:'plan-request',expectedVersion:0,text:'Plan',acceptanceCriteria:['Pass'],approvedScopeRef:'scope-1'};
  const b=bridge();assert.equal(await b.publish(plan),true);
  assert.equal(b.binding().operation,'ownerPlan');assert.equal(b.binding().requestID,plan.requestID);assert.equal(b.binding().planHash,peers.planHash(plan));
  assert.equal(b.calls[0].input.plan.text,'Plan');assert.equal(b.calls[0].input.authorization,'private-capability');
  const cancelled=bridge(()=>{},0);await assert.rejects(cancelled.publish(plan),/CANCELLED/);assert.equal(cancelled.issued(),0);assert.equal(cancelled.calls.length,0);
});

test('dialog-time project, endpoint, client, window and cancellation changes deny grant',async()=>{
  for(const change of [
    ({controller})=>controller.abort(),
    ({endpoint})=>{endpoint.url='different-server'},
    ({endpoint})=>{endpoint.sameMachine=false},
    ({ctx})=>{ctx.client={...ctx.client}},
    ({ctx})=>{ctx.windows.get=()=>undefined},
    ({ctx})=>{ctx.client.project.list=async()=>[{id:'other',canonical:process.cwd()}]},
  ]){
    const value=bridge(change);
    await assert.rejects(value.run(),/PILOT_OWNER_/);
    assert.equal(value.issued(),0);assert.equal(value.calls.length,0);
  }
});

test('concurrent same-window confirmation cannot issue duplicate grants',async()=>{
  let release;
  const value=bridge(()=>new Promise(resolve=>{release=resolve}));
  const first=value.run();
  await assert.rejects(value.run(),/PILOT_OWNER_WINDOW_REQUIRED/);
  // Let main-owned project reads reach native confirmation without timers.
   for(let i=0;i<20&&!release;i++)await Promise.resolve();
  assert.ok(release);release();
  assert.equal(await first,true);assert.equal(value.issued(),1);
});
