import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicModels,memberModel} from '../src/pilot-models.mjs';
test('public catalog omits unavailable models and secrets, preserves explicit zero prices',()=>{
  const base={providerID:'p',id:'m',name:'M',enabled:true,status:'active',variants:[{id:'medium',settings:{secret:'hidden'}}],settings:{apiKey:'hidden'},cost:[],limit:{context:200000,output:32000}};
  const catalog=publicModels([base,{...base,enabled:false},{...base,type:'image'},{...base,status:'deprecated'},{...base,enabled:undefined}]);
  assert.equal(catalog.length,1);
  assert.equal(JSON.stringify(catalog).includes('hidden'),false);
  assert.deepEqual(catalog[0].cost,[]);
  assert.equal(catalog[0].context,200000);
  assert.deepEqual(publicModels([{...base,cost:[{input:0,output:0},{input:-1,output:1}]}])[0].cost,[{input:0,output:0}]);
  assert.throws(()=>publicModels({}),/CATALOG_INVALID/);
  assert.equal(memberModel({model:{providerID:'p',id:'m',variant:'medium'}},catalog).available,true);
  assert.equal(memberModel({model:{providerID:'p',id:'m',variant:'high'}},catalog).available,false);
  assert.equal(memberModel({},catalog).selection,null);
  assert.equal(memberModel({model:{providerID:'other',id:'m'}},catalog).available,false);
});
