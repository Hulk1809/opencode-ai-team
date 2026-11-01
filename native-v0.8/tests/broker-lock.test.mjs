import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp} from 'node:fs/promises';
import {once} from 'node:events';
test('kernel process fence blocks second writer and releases after isolated process crash',async()=>{
  const root=await mkdtemp('/tmp/opencode/fence-'),runner=new URL('../src/broker-lock-runner.py',import.meta.url).pathname;
  const args=[runner,root+'/lock',process.execPath,'-e',"console.log('locked');setInterval(()=>{},1000)"];
  const child=spawn('/usr/bin/python3',args,{stdio:['ignore','pipe','pipe']});
  try{
    await once(child.stdout,'data');
    await assert.rejects(promisify(execFile)('/usr/bin/python3',[runner,root+'/lock',process.execPath,'-e','process.exit(0)']),/already running/);
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;
    await promisify(execFile)('/usr/bin/python3',[runner,root+'/lock',process.execPath,'-e','process.exit(0)']);
  }finally{child.kill('SIGKILL');}
});
