import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {test} from 'node:test'

test('Desktop polling preserves action errors until next action',()=>{
  const source=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8')
  const refresh=source.slice(source.indexOf('async function refresh()'),source.indexOf('function act('))
  assert.ok(refresh.includes("setRPCError('')"))
  assert.ok(!refresh.includes('setError('))
  assert.ok(source.includes('actionError()||rpcError()'))
  assert.ok(source.includes('loading:loading(),error:rpcError(),status:'))
})
