import {readFile,mkdir,copyFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const root=process.cwd(),out=path.join(root,'.isolated/offline-desktop-fixture');
await mkdir(out); // Fail if output exists: never overwrite an earlier input snapshot.
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const records=[],packages=new Map(),unresolved=[];
async function copy(source,target){
  const stat=await lstat(source);if(stat.isSymbolicLink())throw Error('Symlink in offline inputs');
  if(stat.isDirectory()){for(const name of (await readdir(source)).sort()){
    if(source.includes('/node_modules/')&&(/\.d\.[cm]?ts$|\.map$/.test(name)||/^(test|tests|examples|docs|node_modules)$/.test(name)))continue;
    await copy(path.join(source,name),path.join(target,name));
  }return;}
  if(!stat.isFile())throw Error('Non-file input');
  const bytes=await readFile(source);
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\/home\/hulk\//.test(bytes.toString('utf8')))throw Error('Sensitive pattern or host path in '+path.basename(source));
  await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
  records.push({path:path.relative(out,target),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
async function dependency(name,base){
  let dir=base,source;
  for(;;){const candidate=path.join(dir,'node_modules',name);try{await lstat(path.join(candidate,'package.json'));source=candidate;break;}catch{}const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
  if(!source){unresolved.push(name);return;}
  const pkg=await read(path.join(source,'package.json'));
  if(packages.has(name)){if(packages.get(name).version!==pkg.version)unresolved.push(`MULTIVERSION:${name}@${pkg.version}`);return;}
  packages.set(name,{name,version:pkg.version,dependencies:pkg.dependencies??{},optionalDependencies:pkg.optionalDependencies??{},peerDependencies:pkg.peerDependencies??{},scriptsPresent:Object.keys(pkg.scripts??{})});
  for(const child of Object.keys(pkg.dependencies??{}).sort())await dependency(child,source);
}
for(const name of ['adapter.mjs','server.mjs','README.md'])await copy(path.join(root,'tests/fixtures/desktop-offline',name),path.join(out,name));
await copy(path.join(root,'dist/gui-experimental.cjs'),path.join(out,'gui-experimental.cjs'));
const rpc=ts.transpileModule(await readFile(path.join(root,'src/rpc.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
await writeFile(path.join(out,'rpc.mjs'),rpc);
await writeFile(path.join(out,'package.json'),JSON.stringify({name:'ai-team-offline-desktop-fixture',version:'0.0.0-fixture',private:true,type:'module',exports:{'.':'./server.mjs','./gui-experimental':'./gui-experimental.cjs','./rpc':'./rpc.mjs'},dependencies:{'@opencode/plugin':'2.2.0'}},null,2)+'\n');
await dependency('@opencode/plugin',root);
await writeFile(path.join(out,'DEPENDENCIES.json'),JSON.stringify({desktop:'2.2.0',packages:[...packages.values()],unresolved,runtimeDependencies:'NOT INCLUDED: multiversion layout requires review; no install allowed',optionalAndPeerResolution:'REVIEW_REQUIRED',systemInputs:'MISSING: Ubuntu image, Desktop deb, OS dependencies',nativeBootstrap:'BLOCKED'},null,2)+'\n');
for(const name of ['rpc.mjs','package.json','DEPENDENCIES.json']){const bytes=await readFile(path.join(out,name));records.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await writeFile(path.join(out,'SHA256.json'),JSON.stringify(records.sort((a,b)=>a.path.localeCompare(b.path)),null,2)+'\n');
console.log(JSON.stringify({output:'.isolated/offline-desktop-fixture',files:records.length,packages:packages.size,unresolved}));
