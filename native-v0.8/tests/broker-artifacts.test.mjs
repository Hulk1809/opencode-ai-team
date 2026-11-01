import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,symlink} from 'node:fs/promises';
import {brokerArtifacts} from '../src/broker-artifacts.mjs';
test('artifact store retains bytes, deduplicates, rejects tamper, symlink and malformed references',async()=>{
  const directory=await mkdtemp('/tmp/opencode/artifacts-'),store=brokerArtifacts(directory),bytes=Buffer.from('artifact');
  const hash=await store.put(bytes);assert.equal(await store.put(bytes),hash);await store.verify(hash);
  await assert.rejects(store.verify('../escape'),/Invalid/);
  await chmod(`${directory}/${hash}`,0o600);await writeFile(`${directory}/${hash}`,'tampered');
  await assert.rejects(store.verify(hash),/tampered/);await assert.rejects(store.put(bytes),/tampered/);
  const other='0'.repeat(64);await symlink(`${directory}/${hash}`,`${directory}/${other}`);await assert.rejects(store.verify(other),{code:'ELOOP'});
});
