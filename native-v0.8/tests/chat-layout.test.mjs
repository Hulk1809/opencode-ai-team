import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('chat layout uses mounted host queries and bounded independent scroll regions',async()=>{
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  const css=await readFile(new URL('../src/chat-style.ts',import.meta.url),'utf8');
  assert.match(gui,/class="ai-team-host"><div class="ai-team-pane"/);
  assert.match(css,/\.ai-team-host\{[^}]*container:team-chat \/ inline-size/);
  assert.match(css,/\.ai-team-pane\{grid-template-columns:240px minmax\(0,1fr\)\}/);
  assert.match(css,/grid-template-rows:minmax\(0,1fr\)/);
  assert.match(css,/\.team-main\{display:flex;flex-direction:column/);
  assert.match(css,/\.chat-history\{[^}]*min-height:0[^}]*overflow-y:auto/);
  assert.match(css,/\.composer\{[^}]*flex-wrap:wrap/);
  assert.match(css,/@container team-chat \(max-width:1179px\)/);
  assert.match(css,/@container team-chat \(max-width:759px\)/);
  assert.doesNotMatch(gui,/@media\(max-width:/);
  const history=gui.slice(gui.indexOf('class="chat-history"'),gui.indexOf('<div class="composer">'));
  assert.doesNotMatch(history,/AWS authentication request/);
});

test('polish keeps compact disclosures, truthful unread and composer send guards',async()=>{
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  const components=await readFile(new URL('../src/chat-components.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(gui,/unreadCount|setSeen|unread=\{/);
  assert.match(components,/unread\?:number/);
  assert.doesNotMatch(gui,/class="team-monitor"|class="nav-links"/);
  assert.match(gui,/<details><summary>Quyền & an toàn/);
  assert.match(gui,/class="content-tabs"/);
  assert.match(gui,/class="request-row"/);
  assert.match(gui,/if\(busy\(\)\|\|uploading\(\)/);
  assert.match(gui,/const sentDraft=draft\(\),sentFiles=attached\(\),sentReply=reply\(\),sentRecipient=recipient\(\)/);
  assert.match(gui,/if\(draft\(\)===sentDraft\)setDraft\(""\)/);
  assert.match(gui,/!e.shiftKey&&!e.isComposing&&e.keyCode!==229/);
  assert.match(gui,/if\(!list\|\|uploading\(\)\|\|busy\(\)\)return/);
});
