import test from 'node:test';
import assert from 'node:assert/strict';
import {requestShape} from '../src/diagnostics.mjs';
test('boundary diagnostics retain shape and tool linkage, never content or arbitrary keys',()=>{
  const secret='private-secret-value';
  const shape=requestShape({messages:[{role:'assistant',tool_calls:[{id:'call-1',function:{name:'execute',arguments:secret}}]},{role:'tool',tool_call_id:'call-1',content:secret}], [secret]:secret});
  assert.equal(shape.messages[0].role,'assistant');
  assert.equal(shape.messages[0].tool_calls[0].id.reference,shape.messages[1].tool_call_id.reference);
  assert.ok(!JSON.stringify(shape).includes(secret));
  assert.equal(shape.messages[1].content.stringLength,secret.length);
});
