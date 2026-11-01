import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('compact composer retains controls, IME guards and truthful role/context labels',async()=>{
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  const components=await readFile(new URL('../src/chat-components.tsx',import.meta.url),'utf8');
  const css=await readFile(new URL('../src/chat-style.ts',import.meta.url),'utf8');
  assert.match(gui,/class="composer-menu"/);assert.match(gui,/class="composer-options"/);
  assert.match(gui,/!e.shiftKey&&!e.isComposing&&e.keyCode!==229/);
  assert.match(gui,/File visibility/);assert.match(gui,/Người nhận/);assert.match(gui,/ComposerTools/);
  assert.match(gui,/pending <span class="unread-count"/);
  assert.match(components,/devops:'DevOps',qa:'QA'/);
  assert.doesNotMatch(components,/<span class="role-badge">\{props.from\}/);
  assert.match(css,/\.composer details\.composer-menu\{flex:none;position:static\}/);
  assert.match(gui,/class="task-reference"/);
});
