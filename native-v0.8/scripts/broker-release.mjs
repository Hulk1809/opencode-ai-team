import {readFile,mkdir,writeFile,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const source=fileURLToPath(new URL('../src/',import.meta.url));
// Draft release, not installation or security approval. No external package dependencies.
export async function createBrokerRelease(destination){
  const root=resolve(destination),files=new Map();
  async function collect(path){
    path=await realpath(path);const name=relative(source,path);
    if(name.startsWith('..')||name.startsWith('/'))throw Error('Executable outside broker source root');
    if(files.has(name))return;
    const bytes=await readFile(path),text=bytes.toString();files.set(name,bytes);
    const imports=[...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]);
    for(const specifier of imports){
      if(specifier.startsWith('node:'))continue;
      if(!specifier.startsWith('./'))throw Error(`Unreviewed executable dependency: ${specifier}`);
      await collect(resolve(dirname(path),specifier));
    }
    if(/\bimport\s*\(\s*[^'"\s]/.test(text))throw Error('Computed import requires review');
  }
  await collect(join(source,'broker-service.mjs'));
  files.set('broker-lock-runner.py',await readFile(join(source,'broker-lock-runner.py')));
  await mkdir(root,{mode:0o700});
  const inventory=[];
  for(const [name,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b))){
    await writeFile(join(root,name),bytes,{flag:'wx',mode:0o400});
    inventory.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await writeFile(join(root,'SHA256SUMS'),inventory.map(row=>`${row.sha256}  ${row.path}\n`).join(''),{flag:'wx',mode:0o400});
  return {directory:root,inventory};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.argv[2])throw Error('Usage: node scripts/broker-release.mjs NEW_DIRECTORY');
  console.log(JSON.stringify(await createBrokerRelease(process.argv[2])));
}
