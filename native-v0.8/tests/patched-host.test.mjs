import test from 'node:test';
import assert from 'node:assert/strict';
import {patchedCanonical,requirePatchedCanonical} from '../src/patched-host.mjs';

test('official host never receives unauthenticated canonical fallback',()=>{
  for(const ctx of [{},{canonical:{}},{canonical:{invoke:()=>{throw Error('must not call');}}}]){
    assert.equal(patchedCanonical(ctx),null);
    assert.throws(()=>requirePatchedCanonical(ctx),/PATCHED_CANONICAL_API_REQUIRED/);
  }
  const canonical={register(){},invoke(){}};
  assert.equal(requirePatchedCanonical({canonical}),canonical);
});
