import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {TeamRoom} from '../src/room.mjs';
import {nativeCaller} from '../src/native-caller.mjs';

const exec=promisify(execFile);
test('deterministic two-worker app plumbing: isolated edits, peer messages, reconnect and integration checks',async()=>{
  const root=await mkdtemp('/tmp/opencode/practical-workers-');
  const directory=join(root,'project');await mkdir(directory);
  const git=(cwd,...args)=>exec('git',args,{cwd,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  await git(directory,'init','-b','main');
  const store=new Map(),sessions=new Map(),transcripts=new Map();
  const ctx={options:{workers:2},location:{directory,project:{id:'fixture',canonical:directory}},
    storage:{get:async k=>structuredClone(store.get(k)),set:async(k,v)=>store.set(k,structuredClone(v))},
    agent:{list:async()=>['admin','worker-1','worker-2'].map(id=>({id}))},
    worktree:{create:async({name})=>{
      const role=name.split('-').slice(-2).join('-');const path=join(root,role==='s-admin'?'admin':role);
      await git(directory,'worktree','add','--orphan','-b',name,path);return {directory:path};
    }},
    session:{
      create:async({title,metadata})=>{const id=title.split(' | ').at(-1);const s={id,projectID:'fixture',metadata,location:{directory}};sessions.set(id,s);return s;},
      switchAgent:async({sessionID,agent})=>{sessions.get(sessionID).agent=agent;},
      get:async({sessionID})=>sessions.get(sessionID),
      move:async({sessionID,directory})=>{sessions.get(sessionID).location.directory=directory;},
      update:async()=>{}, // Mock permissions; never claims native enforcement.
      context:async({sessionID})=>transcripts.get(sessionID)??[],
      prompt:async o=>{transcripts.set(o.sessionID,[...(transcripts.get(o.sessionID)??[]),{id:o.id,type:'user'}]);return {id:o.id};},
    }};
  const room=new TeamRoom(ctx);await room.create(directory);
  let team=await room.read(directory);team.projectID='fixture';await room.write(directory,team);
  assert.deepEqual(Object.keys(team.members),['admin','worker-1','worker-2']);
  for(const member of Object.values(team.members))assert.ok(member.directory,member.isolationError);
  const batch=await room.assignBatch(directory,'admin',{requestID:'app',tasks:[
    {key:'sum',assignee:'worker-1',title:'Sum',description:'Export sum in sum.mjs; check locally'},
    {key:'label',assignee:'worker-2',title:'Label',description:'Export label in label.mjs; check locally'},
  ]});
  assert.equal(batch.tasks.length,2);
  const message=await room.sendAsSession(directory,'worker-1','worker-2','Use named exports; sum(2,3) equals 5.');
  await room.sendAsSession(directory,'worker-2','worker-1','Acknowledged; label(5) returns Total: 5.');
  await room.sendAsSession(directory,'worker-1','admin','Task accepted; local checks next.');
  const reopened=new TeamRoom(ctx);assert.ok((await reopened.read(directory)).messages.some(m=>m.id===message));
  await assert.rejects(room.sendAsSession(directory,'outsider','admin','spoof'),/Session/);
  await assert.rejects(room.send(directory,'admin','worker-3','unregistered'),/ROOM_MEMBER_REQUIRED/);
  const features=[['worker-1','sum.mjs','export const sum = (a,b) => a+b;\n','sum(2,3)',5],['worker-2','label.mjs','export const label = n => `Total: ${n}`;\n','label(5)','Total: 5']];
  await Promise.all(features.map(async([role,file,source,expression,expected])=>{
    const caller=await nativeCaller(ctx,room,role);assert.equal(caller.role,role);
    const cwd=team.members[role].directory;
    assert.equal(await realpath(cwd),(await git(cwd,'rev-parse','--show-toplevel')).stdout.trim());
    const branch=(await git(cwd,'symbolic-ref','--short','HEAD')).stdout.trim();assert.notEqual(branch,'main');assert.ok(branch.endsWith(role));
    await writeFile(join(cwd,file),source);
    await exec(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {${file.split('.')[0]}} from './${file}';assert.equal(${expression},${JSON.stringify(expected)});`],{cwd});
    // Review exact artifact before copying; no commit, main edit or merge.
    assert.equal(await readFile(join(cwd,file),'utf8'),source);
  }));
  const integration=join(root,'integration');await git(directory,'worktree','add','--orphan','-b','integration',integration);
  for(const [role,file,source] of features){
    await git(team.members[role].directory,'diff','--no-index','/dev/null',file).catch(e=>{assert.equal(e.code,1);assert.ok(e.stdout.includes(source.trim()));});
    await writeFile(join(integration,file),await readFile(join(team.members[role].directory,file)));
  }
  await exec(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';import {label} from './label.mjs';assert.equal(label(sum(2,3)),'Total: 5');"],{cwd:integration});
  assert.equal((await git(directory,'status','--porcelain')).stdout,'');
  console.log(JSON.stringify({fixture:root,nativeAPI:'MOCK',provider:'NOT_RUN',integration:'PASS',main:'UNTOUCHED'}));
});
