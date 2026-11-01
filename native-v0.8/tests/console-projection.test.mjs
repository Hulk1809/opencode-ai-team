import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxProjection} from '../src/console-projection.mjs';
test('console counters distinguish unread from pending and filters never grant authority or mutate fixtures',()=>{
  const rows=[{requestID:'a',project:'one',status:'PENDING_REVIEW'},{requestID:'b',project:'one',status:'SEEN'},{requestID:'c',project:'two',status:'DISMISSED'},{requestID:'d',project:'two',status:'EXPIRED'}];
  const before=structuredClone(rows),result=inboxProjection(rows,{status:'SEEN',project:'one'});
  assert.equal(result.pending,2);assert.equal(result.unread,1);
  assert.deepEqual(result.requests,[rows[1]]);assert.equal(result.authorization,false);
  assert.deepEqual(inboxProjection(rows,{project:'missing'}).requests,[]);
  assert.deepEqual(rows,before);
});
