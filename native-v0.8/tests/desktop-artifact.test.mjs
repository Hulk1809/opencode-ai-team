import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {Script} from 'node:vm';
import ts from 'typescript';

test('Desktop GUI export is one parseable CJS artifact without fixture/server imports',async()=>{
  const root=new URL('../',import.meta.url);
  const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
  assert.equal(pkg.exports['./gui-experimental'],'./dist/gui-experimental.cjs');
  assert.equal(pkg.exports['.'],'./src/index.ts');assert.equal(pkg.exports['./rpc'],'./src/rpc.ts');
  assert.equal(createRequire(import.meta.url).resolve(`${pkg.name}/gui-experimental`),new URL(pkg.exports['./gui-experimental'],root).pathname);
  const bundle=await readFile(new URL(pkg.exports['./gui-experimental'],root),'utf8');
  new Script(bundle); // Parse only: never evaluate plugin or contact Desktop/server.
  assert.doesNotMatch(bundle,/127\.0\.0\.1|localhost|4178|tests\/fixtures|fixtureProject|fixtureCalls|FIXTURE ONLY|\/fixture\/|@vite\/client/);
  const allowed=new Set(['solid-js','solid-js/web','@opencode/plugin/gui','@opencode/plugin/rpc']);
  const ast=ts.createSourceFile('gui.cjs',bundle,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const external=new Set();
  function visit(node){
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'){
      assert.equal(node.arguments.length,1);assert.ok(ts.isStringLiteral(node.arguments[0]));
      const name=node.arguments[0].text;assert.ok(allowed.has(name),`Unexpected external: ${name}`);external.add(name);
    }
    assert.notEqual(node.kind,ts.SyntaxKind.ImportKeyword,'Second chunk/dynamic import forbidden');
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(external.has('@opencode/plugin/gui'));assert.match(bundle,/exports\.default\s*=/);
  const config=await readFile(new URL('vite.config.ts',root),'utf8');
  assert.match(config,/@opencode\/plugin\/gui\/vite/);assert.match(config,/plugins:\[gui\(\)\]/);
});

test('Desktop contributions and component lifetime remain in native GUI entry',async()=>{
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  assert.match(gui,/ctx\.add\(Panel,/);assert.match(gui,/render:\(\)=> <TeamPane\/>/);
  assert.match(gui,/ctx\.add\(Command,/);assert.match(gui,/ctx\.add\(MenuItem,/);assert.match(gui,/ctx\.add\(Style,/);
  assert.match(gui,/onCleanup\(\(\)=>clearInterval\(timer\)\)/);assert.match(gui,/onCleanup\(\(\)=>scope\.dispose\(\)\)/);
  assert.doesNotMatch(gui,/tests\/fixtures|127\.0\.0\.1|localhost|4178|createServer\(/);
});
