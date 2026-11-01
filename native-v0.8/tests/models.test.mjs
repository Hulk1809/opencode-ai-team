import test from 'node:test';
import assert from 'node:assert/strict';
import {TeamModels} from '../src/models.mjs';
import {TeamRoom} from '../src/room.mjs';
test('switchModel xác minh catalog/variant/busy, giữ session và lưu default qua instance mới',async()=>{
  const storage=new Map(),session={id:'s-admin',model:{providerID:'p',id:'flash'}};let transcript=[{type:'idle'}],calls=0;
  const ctx={storage:{get:async k=>structuredClone(storage.get(k)),set:async(k,v)=>storage.set(k,structuredClone(v))},model:{list:async()=>[{providerID:'p',id:'gpt',variants:[{id:'medium'}],enabled:true}]},session:{get:async()=>structuredClone(session),context:async()=>transcript,switchModel:async({sessionID,model})=>{assert.equal(sessionID,session.id);calls++;session.model=model;}}};
  const room=new TeamRoom(ctx);await room.write('/p',{members:{admin:{sessionID:session.id}},messages:[],tasks:[{id:'keep'}]});
  const models=new TeamModels(ctx,room),input={role:'admin',providerID:'p',modelID:'gpt',variant:'medium',saveDefault:true};
  await assert.rejects(()=>models.change('/p',{...input,modelID:'missing'}),/khả dụng/);
  await assert.rejects(()=>models.change('/p',{...input,variant:'bad'}),/khả dụng/);
  transcript=[{type:'user'}];await assert.rejects(()=>models.change('/p',input),/bận/);assert.equal(calls,0);
  transcript.push({type:'model-switched'});await assert.rejects(()=>models.change('/p',input),/bận/);assert.equal(calls,0);
  transcript=[{type:'idle'}];await models.change('/p',input);
  const restored=await new TeamRoom(ctx).read('/p');assert.deepEqual(restored.modelDefaults.admin,{providerID:'p',id:'gpt',variant:'medium'});assert.equal(restored.members.admin.modelSetting.sessionID,'s-admin');assert.equal(restored.tasks[0].id,'keep');
  await new TeamModels(ctx,new TeamRoom(ctx)).change('/p',{...input,variant:undefined,saveDefault:false});assert.equal(session.model.variant,undefined);assert.equal((await room.read('/p')).modelDefaults.admin.variant,'medium');
});
