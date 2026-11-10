import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, chmodSync, readdirSync, readFileSync, writeFileSync, symlinkSync, renameSync, linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

const moduleURL = new URL('../src/pilot-owner-authority.mjs', import.meta.url).href;
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-owner-'));
  const root = join(home, 'project');
  mkdirSync(root);
  const input = {root, projectID: 'project-real', operation: 'createTeam'};
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {issueOwnerGrant,consumeOwnerGrant,OWNER_GRANT_MAX_AGE_MS} from ${JSON.stringify(moduleURL)}; const input=${JSON.stringify(input)}; ${code}`], {env: {...process.env, HOME: home}, encoding: 'utf8'});
  const ok = code => { const result = run(code); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  return {home, root, input, run, ok, directory: join(home, '.opencode-pilot-owner-authority'), close: () => rmSync(home, {recursive: true, force: true})};
};

test('grant binds canonical root/project/operation; one use; malformed input fails closed', () => {
  const f = fixture();
  try { f.ok(`
    const token=issueOwnerGrant(input);
    for(const scope of [{...input,projectID:'fake'},{...input,operation:'deleteTeam'},{...input,root:input.root+'/..'}])
      assert.throws(()=>consumeOwnerGrant(token,scope),/PILOT_OWNER_GRANT_INVALID/);
    for(const token of ['',null,'../escape','x'.repeat(43)]) assert.throws(()=>consumeOwnerGrant(token,input));
    assert.equal(consumeOwnerGrant(token,input),true);
    assert.throws(()=>consumeOwnerGrant(token,input),/PILOT_OWNER_GRANT_INVALID/);
    assert.throws(()=>issueOwnerGrant({...input,operation:'other'}));
    assert.throws(()=>issueOwnerGrant(input,{signal:AbortSignal.abort()}));
  `); } finally { f.close(); }
});

test('expiry, future timestamps, directory replacement and stale project ID reject', () => {
  const f = fixture();
  try {
    for (const issuedAt of [Date.now() - 61_000, Date.now() + 60_000]) {
      const token = f.ok('console.log(issueOwnerGrant(input))');
      // Find this token file without relying on directory order.
      const hash = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createHash} from 'node:crypto';console.log(createHash('sha256').update(${JSON.stringify(token)}).digest('hex'))`], {encoding:'utf8'}).stdout.trim();
      const target = join(f.directory, hash + '.json');
      writeFileSync(target, JSON.stringify({...JSON.parse(readFileSync(target)), issuedAt}));
      f.ok(`assert.throws(()=>consumeOwnerGrant(${JSON.stringify(token)},input))`);
    }
    const token = f.ok('console.log(issueOwnerGrant(input))');
    renameSync(f.root, f.root + '-old'); mkdirSync(f.root);
    f.ok(`assert.throws(()=>consumeOwnerGrant(${JSON.stringify(token)},input))`);
  } finally { f.close(); }
});

test('bound grants reject stale generation, changed plan, request and operation without consuming valid scope',()=>{
  const f=fixture();
  try{f.ok(`
    const scope={...input,generation:'v08-peer-1',requestID:'request-1',planHash:'a'.repeat(64)};
    const token=issueOwnerGrant(scope);
    for(const change of [{generation:'v08-peer-0'},{requestID:'request-2'},{planHash:'b'.repeat(64)},{operation:'ownerMessage'},{operation:'ownerPlan'}])assert.throws(()=>consumeOwnerGrant(token,{...scope,...change}));
    assert.throws(()=>consumeOwnerGrant(token,input));
    assert.equal(consumeOwnerGrant(token,scope),true);
    assert.throws(()=>consumeOwnerGrant(token,scope));
    assert.throws(()=>issueOwnerGrant({...input,generation:'v08-peer-1'}));
  `);}finally{f.close();}
});

test('unsafe store/file modes, symlinks and hardlinks reject without permission repair', () => {
  for (const attack of ['store-mode', 'store-link', 'file-mode', 'file-link', 'hardlink']) {
    const f = fixture();
    try {
      const token = f.ok('console.log(issueOwnerGrant(input))');
      const file = join(f.directory, readdirSync(f.directory)[0]);
      if (attack === 'store-mode') chmodSync(f.directory, 0o755);
      if (attack === 'store-link') { renameSync(f.directory, f.directory+'-old'); symlinkSync(f.directory+'-old', f.directory); }
      if (attack === 'file-mode') chmodSync(file, 0o644);
      if (attack === 'file-link') { renameSync(file,file+'-old'); symlinkSync(file+'-old',file); }
      if (attack === 'hardlink') linkSync(file,file+'-link');
      f.ok(`assert.throws(()=>consumeOwnerGrant(${JSON.stringify(token)},input),/PILOT_OWNER_GRANT_INVALID/)`);
      if (attack.startsWith('store-')) f.ok('assert.throws(()=>issueOwnerGrant(input))');
    } finally { f.close(); }
  }
});

test('separate processes race: exactly one consumption succeeds', async () => {
  const f = fixture();
  try {
    const token = f.ok('console.log(issueOwnerGrant(input))');
    const code = `import {consumeOwnerGrant} from ${JSON.stringify(moduleURL)};try{consumeOwnerGrant(${JSON.stringify(token)},${JSON.stringify(f.input)});process.exitCode=0}catch{process.exitCode=2}`;
    const results = await Promise.all(Array.from({length:12}, () => new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,HOME:f.home},stdio:'ignore'});
      child.on('error',reject);child.on('exit',resolve);
    })));
    assert.equal(results.filter(code=>code===0).length,1);
    assert.equal(results.filter(code=>code===2).length,11);
  } finally { f.close(); }
});
