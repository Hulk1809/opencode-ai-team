import { test } from 'node:test';
import assert from 'node:assert/strict';

// Run only against explicitly requested localhost service: TEAM_HTTP_TEST=1 npm test
test('HTTP authentication and cross-origin guards',{skip:process.env.TEAM_HTTP_TEST!=='1'},async()=>{
  const base='http://127.0.0.1:4310';
  assert.equal((await fetch(base+'/api/state')).status,401);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'invalid'})})).status,401);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/mcp/unknown',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.match(await (await fetch(base)).text(),/AI Team/);
});
