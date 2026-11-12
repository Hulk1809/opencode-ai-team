import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {runRequiredChecks} from '../src/official-coordinator.mjs';

test('app keyboard check never relies on pointer or programmatic form input',()=>{
  const source=readFileSync(new URL('../src/peer-browser-check.mjs',import.meta.url),'utf8');
  const branch=source.split("}else if(check==='keyboard-only'){")[1].split("}else if(check!=='README commands verified'){")[0];
  assert.match(branch,/page\.keyboard\.type/);
  assert.match(branch,/page\.reload/);
  assert.doesNotMatch(branch,/\.(fill|click|selectOption|setInputFiles)\(/);
});

test('browser checks execute keyboard/mobile inside sandbox; broken module fails closed',async t=>{
  const root=mkdtempSync('/tmp/opencode/browser-check-');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(root+'/src');
  writeFileSync(root+'/styles.css','button {max-width:100%}');
  writeFileSync(root+'/src/kanban.js',`export function renderKanban(root,tasks,onMove){root.replaceChildren(); const live=document.createElement('p');live.setAttribute('aria-live','polite');root.append(live);for(const t of tasks){const title=document.createElement('p');title.textContent=t.title;root.append(title);const b=document.createElement('button');b.setAttribute('aria-label','Move '+t.title);b.textContent='Move';b.onclick=()=>onMove(t.id,'doing');root.append(b)}}`);
  const rows=await runRequiredChecks(root,['keyboard-only check','viewport 375px check']);
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.exitCode,0);assert.match(row.output,/bwrap-v1/);}
  writeFileSync(root+'/index.html',`<form><label>Title<input id="f-title"></label><button>Add</button></form><ul id="list"></ul><script>let tasks=JSON.parse(localStorage.getItem('tasks')||'[]');function draw(){document.querySelector('#list').replaceChildren(...tasks.map(t=>{const li=document.createElement('li');li.textContent=t;return li}))}draw();document.querySelector('form').onsubmit=e=>{e.preventDefault();tasks.push(document.querySelector('#f-title').value);localStorage.setItem('tasks',JSON.stringify(tasks));draw()}</script>`);
  const keyboard=await runRequiredChecks(root,['keyboard-only']);
  assert.equal(keyboard[0].exitCode,0);
  writeFileSync(root+'/src/kanban.js','throw Error("broken component")');
  await assert.rejects(runRequiredChecks(root,['viewport 375px check']));
  await assert.rejects(runRequiredChecks(root,['echo PASS']),/CHECK_FORBIDDEN/);
});
