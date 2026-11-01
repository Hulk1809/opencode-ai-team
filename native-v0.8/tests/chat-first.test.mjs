import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('chat first keeps one sidebar, four tabs and request selection without implicit mutation',async()=>{
  const gui=await readFile(new URL('../src/gui.tsx',import.meta.url),'utf8');
  assert.equal((gui.match(/class="team-nav"/g)||[]).length,1);
  assert.doesNotMatch(gui,/class="team-monitor"|class="nav-links"/);
  assert.match(gui,/createSignal\("Direct Messages"\)/);assert.match(gui,/createSignal\("admin"\)/);
  assert.match(gui,/\['Direct Messages','Chat'\],\['Tasks \/ Kanban','Tasks'\],\['Owner Requests','Requests'\],\['Files & Documents','Files'\]/);
  const open=gui.slice(gui.indexOf('function openRequest'),gui.indexOf('const inbox='));
  assert.doesNotMatch(open,/workspace\(|markRequest\(/);
  assert.match(gui,/requestClose\?\.focus\(\)/);assert.match(gui,/row\?\?requestOpener/);
  assert.match(gui,/e.key==='Escape'/);assert.match(gui,/AUTHORIZATION_DISABLED/);
  assert.match(gui,/button disabled title="Thiếu supported containment/);
  assert.match(gui,/if\(!current\(\)\)return/);
});
