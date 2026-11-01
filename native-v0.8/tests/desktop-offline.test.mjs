import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {createFixture} from './fixtures/desktop-offline/adapter.mjs';
const directory='/fixture/A',workspace=(action,payload={})=>({directory,action,payload});
test('offline fixture shapes, isolation, metadata idempotency and reload',async()=>{
  const f=createFixture();
  assert.equal(Object.keys((await f.call('snapshot',{directory})).members).length,5);
  assert.match((await f.call('send',{directory,recipient:'admin',text:'synthetic'})).id,/^fixture-/);
  assert.equal((await f.call('snapshot',{directory:'/fixture/B'})).messages.length,5);
  for(let i=0;i<2;i++)await f.call('workspace',workspace('owner_request_update',{requestID:'fixture-request-0',status:'SEEN'}));
  const page=await f.call('workspace',workspace('owner_requests'));
  assert.equal(page.requests.length,100);assert.equal(page.requests[0].status,'SEEN');
  assert.equal((await f.call('workspace',workspace('owner_requests',{after:page.next,asOf:page.asOf,snapshot:page.snapshot}))).requests.length,30);
  assert.equal((await createFixture().call('snapshot',{directory})).messages.length,5);
  const data=await f.call('workspace',workspace('download',{fileID:'fixture-file'}));
  assert.equal(Buffer.from(data.base64,'base64').toString(),(await f.call('workspace',workspace('read',{fileID:'fixture-file'}))).text);
  await assert.rejects(f.call('snapshot',{directory:'/home/unknown'}),/PROJECT_DENIED/);
  for(const method of ['execution','memberSend','memberInbox','createTeam','shell','pty'])await assert.rejects(f.call(method,{directory}),/DENIED/);
  for(const action of ['approve_build','approve_coding','build','backup','restore','aws_confirm','task_discussion','upload','share','update','unknown'])await assert.rejects(f.call('workspace',workspace(action)),/DENIED/);
  await assert.rejects(f.call('models',{directory,action:'change'}),/DENIED/);
  await assert.rejects(f.call('workspace',workspace('owner_request_update',{requestID:'fixture-request-0',status:'APPROVED'})),/DENIED/);
});
test('delay/error injection stays local and fixture imports expose no I/O capability',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=createFixture({wait:(d)=>d===directory?gate:Promise.resolve()});
  const a=f.call('snapshot',{directory});assert.equal((await f.call('snapshot',{directory:'/fixture/B'})).messages.length,5);release();await a;
  await assert.rejects(createFixture({wait:()=>Promise.reject(Error('SYNTHETIC_ERROR'))}).call('snapshot',{directory}),/SYNTHETIC_ERROR/);
  for(const name of ['adapter.mjs','server.mjs']){
    const source=await readFile(new URL('./fixtures/desktop-offline/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/fetch\s*\(|Service\.|discover|child_process|node:fs|https?:|\/home\/|process\.|setInterval|setTimeout/);
    const ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const imports=ast.statements.filter(ts.isImportDeclaration).map(x=>x.moduleSpecifier.text);
    assert.deepEqual(imports,name==='server.mjs'?['@opencode/plugin','./rpc.mjs','./adapter.mjs']:[]);
  }
});
test('existing RPC schema and unchanged GUI remain package contracts',async()=>{
  const source=await readFile(new URL('../src/rpc.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('rpc.ts',source,ts.ScriptTarget.Latest,true);
  let definition;
  function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='Rpc.define')definition=node.arguments[0];ts.forEachChild(node,visit);}visit(ast);
  const methods=definition.properties.find(x=>x.name.getText(ast)==='methods');
  assert.deepEqual(methods.initializer.properties.map(x=>x.name.getText(ast)).sort(),['execution','models','workspace','memberSend','memberInbox','createTeam','snapshot','sync','send'].sort());
  const f=createFixture();
  assert.deepEqual(Object.keys(await f.call('send',{directory,recipient:'admin',text:'x'})),['id']);
  for(const bad of [{directory,recipient:'team',text:'x'},{directory,recipient:'admin',text:''}])await assert.rejects(f.call('send',bad),/DENIED/);
});
