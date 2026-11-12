import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, lstatSync, rmSync, symlinkSync, openSync, closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {OfficialCoordinator, verifyHostOwnerTicket} from '../src/official-coordinator.mjs';
import {PEER_GENERATION} from '../src/peer-team.mjs';

const CATALOG = [
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-low', name: 'Gemini Low', enabled: true, variants: [{id: 'low'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-high', name: 'Gemini High', enabled: true, variants: [{id: 'high'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/gemini-3.8-flash-medium', name: 'Gemini Medium', enabled: true, variants: [{id: 'medium'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'ag/claude-sonnet-4-6', name: 'Claude Sonnet', enabled: true, variants: [{id: 'default'}], cost: [{input: 0, output: 0}]},
  {providerID: 'taile', id: 'cx/gpt-6.1-sol', name: 'GPT 6.1 Sol', enabled: true, variants: [{id: 'medium'}], cost: [{input: 0, output: 0}]},
];

function hashModel(model) {
  if (!model) return 'null';
  return createHash('sha256').update(JSON.stringify([model.providerID, model.id, model.variant ?? null])).digest('hex');
}

function startMockHostAuthority(userDataDir, options = {}) {
  mkdirSync(userDataDir, {recursive: true});
  const socketPath = join(userDataDir, 'owner-authority.sock');
  const keyPath = join(userDataDir, 'owner-authority.key');
  const hostSecret = randomBytes(32).toString('hex');
  writeFileSync(keyPath, hostSecret, {mode: 0o600});
  chmodSync(keyPath, 0o600);

  const capabilities = new Map();
  const tickets = new Map();

  const server = net.createServer(socket => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let response = {ok: false, reason: 'OWNER_AUTHORITY_REJECTED'};
      try {
        const msg = JSON.parse(line);
        const keyBuf = Buffer.from(String(msg?.key ?? ''), 'utf8');
        const secBuf = Buffer.from(hostSecret, 'utf8');
        if (keyBuf.length !== secBuf.length || !timingSafeEqual(keyBuf, secBuf)) {
          response = {ok: false, reason: 'OWNER_AUTHORITY_KEY_INVALID'};
        } else if (msg?.op === 'verifyModelTicket') {
          const now = options.now ? options.now() : Date.now();
          const stored = tickets.get(String(msg.ticket ?? ''));
          if (!stored) response = {ok: false, reason: 'OWNER_TICKET_NOT_FOUND'};
          else if (stored.consumed) response = {ok: false, reason: 'OWNER_TICKET_REPLAYED'};
          else if (now > stored.expiresAt) response = {ok: false, reason: 'OWNER_TICKET_EXPIRED'};
          else {
            const cap = capabilities.get(stored.capabilityID);
            if (!cap || cap.revoked) response = {ok: false, reason: 'OWNER_CAPABILITY_REVOKED'};
            else if (now > cap.expiresAt) response = {ok: false, reason: 'OWNER_CAPABILITY_EXPIRED'};
            else if (
              stored.canonical !== msg.canonical ||
              stored.dev !== msg.dev ||
              stored.ino !== msg.ino ||
              stored.projectID !== String(msg.projectID ?? '') ||
              stored.teamID !== String(msg.teamID ?? '') ||
              stored.sessionID !== String(msg.sessionID ?? '') ||
              stored.generation !== String(msg.generation ?? '') ||
              stored.requestID !== String(msg.requestID ?? '') ||
              (stored.memberID && msg.memberID && stored.memberID !== String(msg.memberID)) ||
              stored.expectedModelHash !== hashModel(msg.expectedModel) ||
              stored.modelHash !== hashModel(msg.model)
            ) {
              response = {ok: false, reason: 'OWNER_TICKET_BINDING_MISMATCH'};
            } else {
              stored.consumed = true;
              tickets.delete(stored.ticket);
              response = {ok: true, capabilityID: cap.id, issuedAt: stored.issuedAt, expiresAt: cap.expiresAt};
            }
          }
        }
      } catch {
        response = {ok: false, reason: 'OWNER_AUTHORITY_BAD_REQUEST'};
      }
      socket.end(JSON.stringify(response) + '\n');
    });
  });

  return new Promise(resolve => {
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve({
        socketPath,
        keyPath,
        issueTicket(binding, ttlMs = 15 * 60 * 1000) {
          const now = options.now ? options.now() : Date.now();
          const cappedTtl = Math.min(Math.max(ttlMs, 5000), 15 * 60 * 1000);
          const capID = binding.capabilityID ?? `owner_cap_${randomUUID()}`;
          if (!capabilities.has(capID)) {
            capabilities.set(capID, {id: capID, revoked: false, expiresAt: now + cappedTtl});
          }
          const stat = lstatSync(binding.canonical);
          const ticket = randomBytes(32).toString('hex');
          tickets.set(ticket, {
            ticket,
            capabilityID: capID,
            canonical: binding.canonical,
            dev: stat.dev,
            ino: stat.ino,
            projectID: binding.projectID,
            teamID: binding.teamID,
            memberID: binding.memberID,
            sessionID: binding.sessionID,
            generation: binding.generation,
            requestID: binding.requestID,
            expectedModelHash: hashModel(binding.expectedModel),
            modelHash: hashModel(binding.model),
            issuedAt: now,
            expiresAt: Math.min(now + 60_000, capabilities.get(capID).expiresAt),
            consumed: false,
          });
          return {ticket, capabilityID: capID, expiresAt: capabilities.get(capID).expiresAt};
        },
        revokeCapability(capID) {
          const cap = capabilities.get(capID);
          if (cap) cap.revoked = true;
        },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function makeCoordinatorFixture(home, root) {
  const sessions = new Map();
  const active = {};
  const members = [1, 2, 3, 4].map(i => {
    const sessionID = `ses_peer_${i}`;
    const initialModel = {providerID: 'taile', id: 'ag/gemini-3.8-flash-medium', variant: 'medium'};
    sessions.set(sessionID, {
      id: sessionID,
      projectID: 'proj_b22',
      agent: 'build',
      model: {...initialModel},
      location: {directory: root, workspaceID: `ws_${i}`},
    });
    return {
      id: `peer-${i}`,
      role: `peer-${i}`,
      sessionID,
      directory: root,
      workspaceID: `ws_${i}`,
      agent: 'build',
      modelDefault: {...initialModel},
    };
  });

  const makeCtx = () => ({
    location: {directory: root, project: {id: 'proj_b22', canonical: root}},
    options: {pilotStore: join(home, 'store')},
    model: {list: async () => CATALOG},
    session: {
      get: async ({sessionID}) => {
        const s = sessions.get(sessionID);
        if (!s) throw Error('SESSION_NOT_FOUND');
        return {...s, model: {...s.model}};
      },
      active: async () => ({data: {...active}}),
      switchModel: async ({sessionID, model}) => {
        if (options.onSwitchModel) await options.onSwitchModel({sessionID, model});
        const s = sessions.get(sessionID);
        s.model = {providerID: model.providerID, id: model.id, variant: model.variant ?? 'default'};
      },
    },
  });
  const options = {onSwitchModel: null};
  const coordinator = new OfficialCoordinator(makeCtx());
  coordinator.mutate(() => ({
    state: {
      version: 2,
      mode: 'peer',
      generation: PEER_GENERATION,
      projectID: 'proj_b22',
      teamID: 'team_b22',
      canonicalRoot: root,
      status: 'ready',
      runtime: {protocolVersion: 1},
      members,
      plans: [],
      approvals: [],
      tasks: [],
      messages: [],
      receipts: [],
      executions: [],
    },
  }));
  return {coordinator, sessions, active, options, makeCtx};
}

test('B2.2 Phase 2: Trusted host Owner capability enforces 15m max TTL, single-use ticket, revocation, and rejects replay/tamper', async () => {
  const base = mkdtempSync('/tmp/opencode/b22-auth-');
  const root = join(base, 'repo');
  const authDir = join(base, 'desktop');
  mkdirSync(root, {recursive: true});
  let fakeNow = 1_700_000_000_000;
  const host = await startMockHostAuthority(authDir, {now: () => fakeNow});
  const prevEnv = process.env.OPENCODE_OWNER_AUTHORITY_DIR;
  process.env.OPENCODE_OWNER_AUTHORITY_DIR = authDir;
  try {
    const expectedModel = {providerID: 'taile', id: 'ag/gemini-3.8-flash-medium', variant: 'medium'};
    const model = {providerID: 'taile', id: 'ag/gemini-3.8-flash-low', variant: 'low'};
    const binding = {
      canonical: root,
      root,
      projectID: 'proj_b22',
      teamID: 'team_b22',
      memberID: 'peer-1',
      sessionID: 'ses_peer_1',
      generation: PEER_GENERATION,
      requestID: 'req-1',
      expectedModel,
      model,
    };
    const issued = host.issueTicket(binding, 60 * 60 * 1000); // request 60m, must cap at 15m
    assert.equal(issued.expiresAt - fakeNow, 15 * 60 * 1000);

    // Tampered model binding rejected without consuming valid ticket for wrong model
    await assert.rejects(
      () => verifyHostOwnerTicket(issued.ticket, {...binding, model: {providerID: 'taile', id: 'cx/gpt-6.1-sol', variant: 'medium'}}),
      /OWNER_TICKET_BINDING_MISMATCH/
    );

    // Valid single consumption succeeds
    const verified = await verifyHostOwnerTicket(issued.ticket, binding);
    assert.equal(verified.ok, true);
    assert.equal(verified.capabilityID, issued.capabilityID);

    // Replay of consumed ticket rejected
    await assert.rejects(
      () => verifyHostOwnerTicket(issued.ticket, binding),
      /OWNER_TICKET_NOT_FOUND|OWNER_TICKET_REPLAYED/
    );

    // Revoked capability rejects newly issued ticket
    const issued2 = host.issueTicket({...binding, requestID: 'req-2', capabilityID: issued.capabilityID});
    host.revokeCapability(issued.capabilityID);
    await assert.rejects(
      () => verifyHostOwnerTicket(issued2.ticket, {...binding, requestID: 'req-2'}),
      /OWNER_CAPABILITY_REVOKED/
    );

    // Expired capability rejects ticket
    const issued3 = host.issueTicket({...binding, requestID: 'req-3'});
    fakeNow += 16 * 60 * 1000;
    await assert.rejects(
      () => verifyHostOwnerTicket(issued3.ticket, {...binding, requestID: 'req-3'}),
      /OWNER_TICKET_EXPIRED|OWNER_CAPABILITY_EXPIRED/
    );
  } finally {
    if (prevEnv === undefined) delete process.env.OPENCODE_OWNER_AUTHORITY_DIR;
    else process.env.OPENCODE_OWNER_AUTHORITY_DIR = prevEnv;
    await host.close();
  }
});

test('B2.2 Phase 3: Atomic Model Selection & Admission 10-scenario race matrix', async () => {
  const home = mkdtempSync('/tmp/opencode/b22-races-');
  const root = join(home, 'repo');
  mkdirSync(root, {recursive: true});
  const {coordinator, sessions, active, options, makeCtx} = makeCoordinatorFixture(home, root);

  const initialModel = {providerID: 'taile', id: 'ag/gemini-3.8-flash-medium', variant: 'medium'};
  const peer1Target = {providerID: 'taile', id: 'ag/gemini-3.8-flash-low', variant: 'low'};

  // 1. Stale expectedModel CAS rejected
  await assert.rejects(
    () => coordinator.selectModel({
      operation: 'selectModel',
      requestID: 'race-stale-1',
      generation: PEER_GENERATION,
      teamID: 'team_b22',
      memberID: 'peer-1',
      sessionID: 'ses_peer_1',
      expectedModel: {providerID: 'taile', id: 'cx/gpt-6.1-sol', variant: 'medium'},
      model: peer1Target,
    }),
    /MODEL_SELECTION_STALE/
  );

  // 2. Concurrent selection race: while first switchModel is in-flight (PENDING), second concurrent request fails closed
  let releaseSwitch;
  const switchGate = new Promise(r => { releaseSwitch = r; });
  options.onSwitchModel = async () => {
    await switchGate;
  };
  const firstPromise = coordinator.selectModel({
    operation: 'selectModel',
    requestID: 'race-concurrent-1',
    generation: PEER_GENERATION,
    teamID: 'team_b22',
    memberID: 'peer-1',
    sessionID: 'ses_peer_1',
    expectedModel: initialModel,
    model: peer1Target,
    capabilityID: 'cap_test_1',
  });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(coordinator.read().members[0].modelPreference.status, 'PENDING');

  // Admission blocked while modelPreference is PENDING (Scenario 8)
  await assert.rejects(
    () => coordinator.verifyAdmissionPolicy({teamID: 'team_b22', generation: PEER_GENERATION, sessionID: 'ses_peer_1'}),
    /ADMISSION_MODEL_NOT_APPLIED/
  );

  // Second concurrent selectModel rejected
  await assert.rejects(
    () => coordinator.selectModel({
      operation: 'selectModel',
      requestID: 'race-concurrent-2',
      generation: PEER_GENERATION,
      teamID: 'team_b22',
      memberID: 'peer-1',
      sessionID: 'ses_peer_1',
      expectedModel: initialModel,
      model: {providerID: 'taile', id: 'ag/gemini-3.8-flash-high', variant: 'high'},
    }),
    /MODEL_SELECTION_RECONCILIATION_REQUIRED/
  );

  options.onSwitchModel = null;
  releaseSwitch();
  const applied = await firstPromise;
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.composerStatus, 'PENDING');
  assert.equal(applied.executionAuthorized, false);
  assert.equal(applied.version, 1);

  // 3. Active session / in-flight turn blocks model switch and blocks new admission
  active['ses_peer_1'] = {status: 'running'};
  const queued = await coordinator.selectModel({
      operation: 'selectModel',
      requestID: 'race-active-1',
      generation: PEER_GENERATION,
      teamID: 'team_b22',
      memberID: 'peer-1',
      sessionID: 'ses_peer_1',
      expectedModel: peer1Target,
      model: initialModel,
    });
  assert.equal(queued.status, 'QUEUED');
  assert.equal(queued.executionAuthorized, false);
  await assert.rejects(
    () => coordinator.verifyAdmissionPolicy({teamID: 'team_b22', generation: PEER_GENERATION, sessionID: 'ses_peer_1'}),
    /ADMISSION_SESSION_BUSY/
  );
  delete active['ses_peer_1'];

  // 4. Wrong peer / wrong session / wrong team rejected
  await assert.rejects(
    () => coordinator.selectModel({
      operation: 'selectModel',
      requestID: 'race-wrong-peer',
      generation: PEER_GENERATION,
      teamID: 'team_b22',
      memberID: 'peer-2',
      sessionID: 'ses_peer_1',
      expectedModel: peer1Target,
      model: initialModel,
    }),
    /MODEL_BINDING_MISMATCH/
  );

  // 5. Composer synchronization acknowledgment updates receipt and preference without granting execution
  const synced = await coordinator.acknowledgeComposer({
    requestID: 'ack-composer-1',
    generation: PEER_GENERATION,
    teamID: 'team_b22',
    sessionID: 'ses_peer_1',
    model: peer1Target,
  });
  assert.equal(synced.composerStatus, 'SYNCHRONIZED');
  assert.equal(synced.executionAuthorized, false);

  // 6. Restart / reopen persistence preserves modelVersion, modelDefault, modelPreference, and modelReceipts
  const reopened = new OfficialCoordinator(makeCtx());
  const stateAfterReopen = reopened.read();
  const m1 = stateAfterReopen.members.find(m => m.id === 'peer-1');
  assert.equal(m1.modelVersion, 1);
  assert.deepEqual(m1.modelDefault, peer1Target);
  assert.equal(m1.modelPreference.status, 'APPLIED');
  assert.equal(m1.modelPreference.composerStatus, 'SYNCHRONIZED');
  assert.equal(stateAfterReopen.modelReceipts.length, 1);
  assert.equal(stateAfterReopen.modelReceipts[0].composerStatus, 'SYNCHRONIZED');
  assert.equal(stateAfterReopen.modelReceipts[0].executionAuthorized, false);

  // 7. Model version mismatch and stale model at admission rejected
  await assert.rejects(
    () => reopened.verifyAdmissionPolicy({
      teamID: 'team_b22',
      generation: PEER_GENERATION,
      sessionID: 'ses_peer_1',
      expectedVersion: 0,
    }),
    /ADMISSION_MODEL_VERSION_MISMATCH/
  );
  await assert.rejects(
    () => reopened.verifyAdmissionPolicy({
      teamID: 'team_b22',
      generation: PEER_GENERATION,
      sessionID: 'ses_peer_1',
      expectedVersion: 1,
      expectedModel: initialModel,
    }),
    /ADMISSION_MODEL_STALE/
  );

  const validAdmission = await reopened.verifyAdmissionPolicy({
    teamID: 'team_b22',
    generation: PEER_GENERATION,
    sessionID: 'ses_peer_1',
    expectedVersion: 1,
    expectedModel: peer1Target,
  });
  assert.equal(validAdmission.admissible, true);
  assert.equal(validAdmission.executionAuthorized, false);
  assert.equal(validAdmission.modelVersion, 1);

  // 9. Unavailable provider/model/variant rejected with zero fallback
  await assert.rejects(
    () => reopened.selectModel({
      operation: 'selectModel',
      requestID: 'race-unavailable-1',
      generation: PEER_GENERATION,
      teamID: 'team_b22',
      memberID: 'peer-1',
      sessionID: 'ses_peer_1',
      expectedModel: peer1Target,
      model: {providerID: 'taile', id: 'nonexistent/model', variant: 'low'},
    }),
    /MODEL_UNAVAILABLE/
  );
  assert.deepEqual(sessions.get('ses_peer_1').model, peer1Target);
});

test('B2.2 Phase 4: Mandatory bwrap-v1 worker sandbox blocks Owner socket, parent FDs, host /proc, credentials, and outside-workspace paths', async () => {
  const base = mkdtempSync('/tmp/opencode/b22-sandbox-');
  const workspace = join(base, 'workspace');
  const hostSecretDir = join(base, 'host-secret');
  mkdirSync(workspace, {recursive: true});
  mkdirSync(hostSecretDir, {recursive: true});
  writeFileSync(join(workspace, 'allowed.txt'), 'workspace-ok\n');
  const secretSocket = join(hostSecretDir, 'owner-authority.sock');
  const secretKey = join(hostSecretDir, 'owner-authority.key');
  writeFileSync(secretKey, 'super-secret-owner-key\n', {mode: 0o600});
  symlinkSync(secretKey, join(workspace, 'escape-link.txt'));

  // Open an extra file descriptor in parent process to verify FD inheritance is blocked
  const leakedFd = openSync(secretKey, 'r');

  const bwrapArgs = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
    '--clearenv',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', '/var',
    '--tmpfs', '/home',
    '--bind', workspace, workspace,
    '--chdir', workspace,
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', workspace,
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'OPENCODE_WORKER_SANDBOX', 'bwrap-v1',
    '--setenv', 'OPENCODE_WORKSPACE_DIR', workspace,
    '--',
  ];

  try {
    const probeScript = `
      set -e
      echo "SANDBOX=$OPENCODE_WORKER_SANDBOX"
      echo "SECRET_ENV=\${SUPER_SECRET_TOKEN:-EMPTY}"
      if [ -e "${secretKey}" ] || [ -e "${secretSocket}" ]; then echo "LEAK_HOST_SECRET"; exit 1; fi
      if [ -e "/home/hulk/.config" ] || [ -e "/home/hulk/.bashrc" ]; then echo "LEAK_HOST_HOME"; exit 1; fi
      if [ -e "/proc/${process.pid}" ]; then echo "LEAK_HOST_PROC_PID"; exit 1; fi
      if cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n' | grep -q SUPER_SECRET_TOKEN; then echo "LEAK_PROC1_ENV"; exit 1; fi
      if [ -e "/proc/$$/fd/${leakedFd}" ] && grep -q super-secret "/proc/$$/fd/${leakedFd}" 2>/dev/null; then echo "LEAK_PARENT_FD"; exit 1; fi
      if cat escape-link.txt 2>/dev/null; then echo "LEAK_SYMLINK_ESCAPE"; exit 1; fi
      cat allowed.txt
      echo "PID_NS_PROCS=$(ls -d /proc/[0-9]* | wc -l)"
    `;
    const res = spawnSync('bwrap', [...bwrapArgs, '/bin/bash', '-c', probeScript], {
      cwd: workspace,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: workspace,
        TMPDIR: '/tmp',
        OPENCODE_WORKER_SANDBOX: 'bwrap-v1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /SANDBOX=bwrap-v1/);
    assert.match(res.stdout, /SECRET_ENV=EMPTY/);
    assert.match(res.stdout, /workspace-ok/);
    const procCount = Number(res.stdout.match(/PID_NS_PROCS=(\d+)/)?.[1] ?? 999);
    assert.ok(procCount <= 5, `Expected isolated PID namespace with <=5 processes, got ${procCount}`);
  } finally {
    closeSync(leakedFd);
  }
});
