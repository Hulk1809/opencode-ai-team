import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {guiScope} from '../src/gui-scope.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
test('fast A/B/A switching rejects delayed success, errors and out-of-order finalizers; dispose fences all',async()=>{
  const scope=guiScope(),state={messages:[],tasks:[],requests:[],files:[],error:'',loading:true};
  async function load(response){const current=scope.capture();try{const value=await response.promise;if(current())Object.assign(state,value);}catch(e){if(current())state.error=e.message;}finally{if(current())state.loading=false;}}
  const a=deferred(),b=deferred(),again=deferred(),first=load(a);
  scope.invalidate();const second=load(b);scope.invalidate();const third=load(again);
  b.reject(Error('old B error'));a.resolve({messages:['old A'],tasks:['old'],requests:['old'],files:['old']});
  await Promise.all([first,second]);assert.deepEqual(state,{messages:[],tasks:[],requests:[],files:[],error:'',loading:true});
  again.resolve({messages:['new A'],tasks:['new'],requests:['new'],files:['new']});await third;
  assert.equal(state.messages[0],'new A');assert.equal(state.error,'');assert.equal(state.loading,false);
  const late=deferred(),last=load(late);scope.dispose();late.resolve({messages:['unmounted']});await last;
  assert.equal(state.messages[0],'new A');assert.equal(scope.capture()(),false);
});
test('current error surfaces, thread invalidation fences pending requests; GUI uses read-only polling with one timer',async()=>{
  const scope=guiScope(),old=scope.capture();scope.invalidate();assert.equal(old(),false);
  const current=scope.capture();assert.equal(current(),true);
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  assert.match(gui,/onCleanup\(\(\)=>scope.dispose\(\)\)/);
  assert.match(gui,/directory\(\);activeThread\(\);view\(\)/);
  assert.equal((gui.match(/setInterval\(/g)||[]).length,1);
  assert.match(gui,/setInterval\(\(\)=>\{void load\(\)\}/);
  assert.match(gui,/if\(current\(\)\)setError/);
  assert.match(gui,/if\(!current\(\)\)return/);
});
