import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dependencies, resolveReceiver } from './helpers.ts';

test('mentions route only to existing roles; dependency IDs stay unique', () => {
  assert.equal(resolveReceiver('@unknown hãy hỏi @developer', 'team', ['developer']), 'developer');
  assert.equal(resolveReceiver('Không có mention', 'reviewer', ['reviewer']), 'reviewer');
  assert.equal(resolveReceiver('@team kiểm tra', 'reviewer', ['reviewer']), 'team');
  assert.equal(resolveReceiver('@developer-extra', 'team', ['developer']), 'team');
  assert.deepEqual(dependencies(' a, b, a, , c '), ['a', 'b', 'c']);
});
