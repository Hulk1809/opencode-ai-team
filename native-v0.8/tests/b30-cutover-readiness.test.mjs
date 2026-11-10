import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import net from 'node:net';
import {
  OfficialCoordinator,
  HOST_SECURITY_BOUNDARY_VERSION,
  EXPECTED_SERVER_VERSION,
  verifyPatchedSidecarBoundary,
  verifyHostOwnerTicket,
  validGitProject,
} from '../src/official-coordinator.mjs';
import {readReport} from '../src/pilot-reports.mjs';
import {selectEngine} from '../src/peer-engine-selection.mjs';
import {PEER_GENERATION} from '../src/peer-team.mjs';

const CATALOG = [
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-low', name: 'Gemini Low', enabled: true, variants: [{id: 'low'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-high', name: 'Gemini High', enabled: true, variants: [{id: 'high'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-medium', name: 'Gemini Medium', enabled: true, variants: [{id: 'medium'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/claude-sonnet-4-6', name: 'Claude Sonnet', enabled: true, variants: [{id: 'default'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'cx/gpt-6.1-sol', name: 'GPT 6.1 Sol', enabled: true, variants: [{id: 'medium'}], cost: [{input: 0, output: 0}]},
];

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
mkdirSync('/tmp/antigravity', {recursive: true});

test('B3.0 Stage 3: Fail-closed sidecar & host security boundary verification blocks unpatched or version-mismatched runtime', async () => {
  // 1. Valid patched 2.2.5 sidecar context passes
  const validCtx = {
    app: {version: EXPECTED_SERVER_VERSION},
    session: {active: async () => ({})},
  };
  const okBoundary = verifyPatchedSidecarBoundary(validCtx);
  assert.equal(okBoundary.ok, true);
  assert.equal(okBoundary.boundaryVersion, HOST_SECURITY_BOUNDARY_VERSION);
  assert.equal(okBoundary.serverVersion, '2.2.5');

  // 2. Auto-updated sidecar version (e.g. 2.2.6) fails closed
  const updatedCtx = {
    app: {version: '2.2.6'},
    session: {active: async () => ({})},
  };
  const verMismatch = verifyPatchedSidecarBoundary(updatedCtx);
  assert.equal(verMismatch.ok, false);
  assert.match(verMismatch.reason, /SIDECAR_VERSION_MISMATCH:2\.2\.6!=2\.2\.5/);

  // 3. Unpatched sidecar missing ctx.session.active fails closed
  const unpatchedCtx = {
    app: {version: '2.2.5'},
    session: {},
  };
  const missingActive = verifyPatchedSidecarBoundary(unpatchedCtx);
  assert.equal(missingActive.ok, false);
  assert.equal(missingActive.reason, 'SIDECAR_UNPATCHED_SESSION_ACTIVE_MISSING');

  // 4. verifyHostOwnerTicket fails closed before touching socket if sidecarBoundary is invalid
  const base = mkdtempSync('/tmp/antigravity/b30-boundary-');
  const root = join(base, 'repo');
  mkdirSync(root, {recursive: true});
  await assert.rejects(
    () =>
      verifyHostOwnerTicket('a'.repeat(64), {
        serverBoundary: verMismatch,
        root,
        projectID: 'proj_1',
        teamID: 'team_1',
        memberID: 'peer-1',
        sessionID: 'ses_1',
        generation: PEER_GENERATION,
        requestID: 'req_1',
        expectedModel: null,
        model: CATALOG[0],
      }),
    /SIDECAR_VERSION_MISMATCH/
  );
});

test('B3.0 Stage 3: Single engine selection, non-Git read-only isolation without git init, and legacy store compatibility', async () => {
  // Engine selection blocks any live execution flag and defaults to legacy-read-only when officialPilot is omitted
  assert.equal(selectEngine({officialPilot: true, nativeDispatch: false, pilotWake: false}), 'canonical');
  assert.equal(selectEngine({officialPilot: false}), 'legacy-read-only');
  assert.throws(() => selectEngine({officialPilot: true, nativeDispatch: true}), /PEER_LIVE_EXECUTION_BLOCKED/);
  assert.throws(() => selectEngine({officialPilot: true, pilotWake: true}), /PEER_LIVE_EXECUTION_BLOCKED/);

  // Non-Git project support: validGitProject returns null and never runs git init
  const base = mkdtempSync('/tmp/antigravity/b30-compat-');
  const nonGitRoot = join(base, 'non-git-project');
  const pilotStore = join(base, 'pilot-store');
  mkdirSync(nonGitRoot, {recursive: true});
  mkdirSync(pilotStore, {recursive: true});
  writeFileSync(join(nonGitRoot, 'README.md'), '# Non-Git\n');

  assert.equal(validGitProject(nonGitRoot), false);
  assert.equal(existsSync(join(nonGitRoot, '.git')), false);

  const sessions = new Map();
  let seq = 0;
  const makeCtx = (root, projectID) => ({
    app: {version: '2.2.5'},
    options: {officialPilot: true, nativeDispatch: false, pilotWake: false, pilotStore},
    location: {directory: root, project: {id: projectID, canonical: root}},
    model: {list: async () => CATALOG},
    session: {
      active: async () => ({}),
      create: async (opts) => {
        const id = `ses_b30_${++seq}`;
        const s = {
          id,
          projectID,
          agent: opts.agent ?? 'build',
          title: opts.title,
          model: opts.model ?? CATALOG[0],
          permissions: opts.permissions ?? [],
          location: {directory: opts.location?.directory ?? root, workspaceID: null},
        };
        sessions.set(id, s);
        return s;
      },
      get: async ({sessionID}) => sessions.get(sessionID),
      messages: async () => [],
      prompt: async () => {
        throw new Error('UNEXPECTED_LIVE_PROMPT');
      },
    },
  });

  const nonGitCoord = new OfficialCoordinator(makeCtx(nonGitRoot, 'proj_nongit'));
  const created = await nonGitCoord.bootstrap();
  assert.equal(created.mode, 'peer');
  assert.equal(created.isolation, 'read-only');
  assert.equal(created.members.length, 4);
  assert.equal(existsSync(join(nonGitRoot, '.git')), false);
});

test('B3.0 Stage 2: Cloned live stores backup, schema compatibility, rollback restore, and non-resumption of uncertain/unfinished executions', async () => {
  const base = mkdtempSync('/tmp/antigravity/b30-rollback-');
  const cloneStore = join(base, 'live-clone');
  const backupDir = join(base, 'backup');
  mkdirSync(cloneStore, {recursive: true});
  mkdirSync(backupDir, {recursive: true});

  // Clone the 3 real live team stores + B2.2 report store into isolated temp directory (read-only copy)
  const liveBase = '/home/hulk/.local/share/opencode/ai-team-v08-clean';
  cpSync(liveBase, cloneStore, {recursive: true});
  cpSync(
    '/home/hulk/aiteam-research/b1/b2-env/pilot-store/0e0c5664f3cb821a64f0776868c1ab4658b85c2e77de4867308e5896a1d7867e',
    join(cloneStore, '0e0c5664f3cb821a64f0776868c1ab4658b85c2e77de4867308e5896a1d7867e'),
    {recursive: true}
  );

  const storeHashes = {};
  for (const hash of [
    '3978217607b23c079fbe98f4501f2d37afadec5bb8f642f1649b9f58daf2c83c',
    'd0b9fb4c66e81e65b2b9d517934eba36006f58dbd9e1321b718fa463e0d46a80',
    'bda48786a846141a8d9073c9ded0de546b54d2e8174957d73b797a4cc9240912',
    '0e0c5664f3cb821a64f0776868c1ab4658b85c2e77de4867308e5896a1d7867e',
  ]) {
    storeHashes[hash] = sha256File(join(cloneStore, hash, 'team.json'));
  }

  // Create verified backup
  cpSync(cloneStore, backupDir, {recursive: true});
  for (const [hash, expected] of Object.entries(storeHashes)) {
    assert.equal(sha256File(join(backupDir, hash, 'team.json')), expected);
  }

  // Verify candidate coordinator reads all 3 cloned stores without mutating them or auto-resuming uncertain wakes
  let promptsCalled = 0;
  const makeCloneCtx = (root, projectID) => ({
    app: {version: '2.2.5'},
    options: {officialPilot: true, nativeDispatch: false, pilotWake: false, pilotStore: cloneStore},
    location: {project: {id: projectID, canonical: root}},
    models: {list: async () => CATALOG},
    session: {
      active: async () => ({}),
      get: async ({sessionID}) => ({id: sessionID, projectID, directory: root, model: CATALOG[2]}),
      messages: async () => [],
      prompt: async () => {
        promptsCalled += 1;
        throw new Error('LIVE_PROMPT_FORBIDDEN');
      },
    },
  });

  // 1. Legacy store 397821... (/home/hulk/projects/v08-desktop-project-b) with 5 messages, 1 done task
  const coordB = new OfficialCoordinator(makeCloneCtx('/home/hulk/projects/v08-desktop-project-b', 'e1fc3b36fc462738a22ff0f685d5c7c44ed610ea'));
  const stateB = coordB.read();
  assert.equal(stateB.status, 'ready');
  assert.equal(stateB.members.length, 3);
  assert.equal(stateB.messages.length, 5);
  assert.equal(stateB.tasks.length, 1);

  // 1b. Managed reports in 0e0c56... (/home/hulk/aiteam-research/b1/b2-env/projects/todo-git) remain integrity-verified and readable
  const coordTodo = new OfficialCoordinator(
    makeCloneCtx('/home/hulk/aiteam-research/b1/b2-env/projects/todo-git', 'eb497f245179f92168c598bd591dd67a29abb7e8')
  );
  const stateTodo = coordTodo.read();
  assert.equal(stateTodo.artifacts.length, 8);
  const report0 = readReport(
    coordTodo.directory,
    stateTodo,
    'eb497f245179f92168c598bd591dd67a29abb7e8',
    'report_0c86e7fb9a3cf1c0770c4b7470616d4e70af0f5e36a572081527258fd15b28dc'
  );
  assert.match(report0.content, /peer-1 task report/);

  // 2. Legacy store d0b9fb... (/home/hulk/projects/v08-desktop-acceptance) with 2 assign messages & 2 todo tasks
  const coordAcc = new OfficialCoordinator(makeCloneCtx('/home/hulk/projects/v08-desktop-acceptance', '7af15c690957779faf78055670eafcd356a1c201'));
  const stateAcc = coordAcc.read();
  assert.equal(stateAcc.status, 'ready');
  assert.equal(stateAcc.messages.filter(m => m.action === 'assign').length, 2);
  assert.equal(stateAcc.tasks.filter(t => t.status === 'todo').length, 2);
  assert.equal(promptsCalled, 0, 'Unfinished todo tasks must never auto-resume');

  // 2b. Inject an uncertain wake & DISPATCHING execution into a cloned store and verify reopen/rollback never auto-resumes
  const uncertainDir = join(cloneStore, 'd0b9fb4c66e81e65b2b9d517934eba36006f58dbd9e1321b718fa463e0d46a80');
  const uncertainState = JSON.parse(readFileSync(join(uncertainDir, 'team.json'), 'utf8'));
  uncertainState.messages[0].wake = {status: 'uncertain', sessionID: 'ses_e599740caffeu4ytztIr1bICpM', promptID: 'msg_uncertain_1'};
  uncertainState.executions = [{id: 'exec_uncertain_1', taskID: uncertainState.tasks[0].id, status: 'DISPATCHING'}];
  writeFileSync(join(uncertainDir, 'team.json'), JSON.stringify(uncertainState));
  const reopenedUncertain = new OfficialCoordinator(makeCloneCtx('/home/hulk/projects/v08-desktop-acceptance', '7af15c690957779faf78055670eafcd356a1c201'));
  assert.equal(reopenedUncertain.read().messages[0].wake.status, 'uncertain');
  assert.equal(reopenedUncertain.read().executions[0].status, 'DISPATCHING');
  assert.equal(promptsCalled, 0, 'Uncertain wakes and DISPATCHING executions must never auto-resume on reopen');

  // 3. Peer store bda487... (/home/hulk/aiteam-dev/owner-inbox)
  const coordInbox = new OfficialCoordinator(makeCloneCtx('/home/hulk/aiteam-dev/owner-inbox', '2960f90ea1d90db49146ef097ddf722852d4a4f7'));
  const stateInbox = coordInbox.read();
  assert.equal(stateInbox.mode, 'peer');
  assert.equal(stateInbox.members.length, 4);

  // Simulate post-cutover mutation on cloneStore, then rollback from backupDir and verify exact SHA-256 match
  writeFileSync(join(cloneStore, 'bda48786a846141a8d9073c9ded0de546b54d2e8174957d73b797a4cc9240912', 'team.json'), '{"mutated":true}\n');
  assert.notEqual(
    sha256File(join(cloneStore, 'bda48786a846141a8d9073c9ded0de546b54d2e8174957d73b797a4cc9240912', 'team.json')),
    storeHashes['bda48786a846141a8d9073c9ded0de546b54d2e8174957d73b797a4cc9240912']
  );

  // Rollback from backupDir
  cpSync(backupDir, cloneStore, {recursive: true});
  for (const [hash, expected] of Object.entries(storeHashes)) {
    assert.equal(sha256File(join(cloneStore, hash, 'team.json')), expected);
  }
  assert.equal(promptsCalled, 0);
});
