import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('B3.1 UI implements 4-peer strip, Zalo/Messenger chat, tabs, CAS model selector and responsive container queries without duplicate sidebar',()=>{
  const pane=readFileSync(new URL('../src/pilot-pane.tsx',import.meta.url),'utf8');
  const routing=readFileSync(new URL('../src/pilot-routing.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/pilot-pane.css',import.meta.url),'utf8');

  // No duplicate app sidebar inside AI Team tab
  assert.doesNotMatch(pane,/class="team-nav"|class="app-sidebar"/);
  // No hardcoded specialist roles in PilotPane peer strip
  assert.doesNotMatch(pane,/Backend|Frontend|DevOps|QA/);

  // Header, 4-Peer strip, Peer detail + CAS Model Selector, 5 tabs, Overview panel
  for(const token of [
    'b31-header',
    'b31-peer-strip',
    'b31-peer-card',
    'b31-peer-detail',
    'PeerModelSelector',
    'b31-tabs',
    "setActiveTab('chat')",
    "setActiveTab('tasks')",
    "setActiveTab('plan')",
    "setActiveTab('reports')",
    "setActiveTab('activity')",
    'b31-kanban-grid',
    'b31-overview-panel',
    'TEST_FIXTURE (Controlled Verification)',
    'WORKTREE AUTHORIZED'
  ]){
    assert.ok(pane.includes(token),`missing token in pilot-pane.tsx: ${token}`);
  }

  // Model selector uses real catalog + trusted CAS selectModel & acknowledgeComposer
  for(const token of [
    'export function PeerModelSelector',
    'Select Provider',
    'Select Model',
    'Variant',
    'SYNCHRONIZED',
    'APPLIED',
    'PENDING',
    'BLOCKED',
    'ctx.main(PilotOwner).selectModel',
    'ctx.main(PilotOwner).acknowledgeComposer'
  ]){
    assert.ok(routing.includes(token),`missing token in pilot-routing.tsx: ${token}`);
  }

  // Responsive container queries for Wide / Medium / Narrow split panel
  assert.match(css,/@container \(max-width:1100px\)/);
  assert.match(css,/@container \(max-width:850px\)/);
  assert.match(css,/@container \(max-width:560px\)/);
});
