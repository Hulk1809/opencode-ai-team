import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createBrokerRelease} from '../scripts/broker-release.mjs';
import {pathToFileURL,fileURLToPath} from 'node:url';
const run=promisify(execFile);
test('draft release copies transitive local closure, hashes bytes and imports independent service entrypoint',async()=>{
  const root=await mkdtemp('/tmp/opencode/release-proof-'),release=await createBrokerRelease(`${root}/release`);
  assert.ok(release.inventory.some(row=>row.path==='broker-runtime.mjs'));
  for(const row of release.inventory)assert.equal(createHash('sha256').update(await readFile(`${release.directory}/${row.path}`)).digest('hex'),row.sha256);
  await run(process.execPath,['--input-type=module','-e',`import {createBrokerApplication} from './release/broker-service.mjs'; if(typeof createBrokerApplication!=='function')throw Error('Missing composition');`],{cwd:root,timeout:10000,env:{PATH:process.env.PATH}});
  await run(process.execPath,['--test',fileURLToPath(new URL('./broker-e2e.test.mjs',import.meta.url))],{cwd:root,timeout:20000,env:{PATH:process.env.PATH,BROKER_TEST_SERVICE_URL:pathToFileURL(`${release.directory}/broker-service.mjs`).href}});
  await assert.rejects(createBrokerRelease(release.directory),{code:'EEXIST'});
});
