import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const HELPER_PATH = "/home/hulk/aiteam-research/b1/b3-oneclick-maintenance-helper.mjs";
const CUTOVER_SCRIPT = "/home/hulk/aiteam-research/b1/b3-maintenance-cutover.sh";
const TEST_ROOT = "/tmp/opencode/b3-oneclick-helper-isolated";

function sha256(bufOrStr) {
  return crypto.createHash("sha256").update(bufOrStr).digest("hex");
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

function createSqliteDb(dbPath) {
  const py = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("PRAGMA journal_mode=WAL;")
conn.execute("CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, title TEXT);")
conn.execute("INSERT OR REPLACE INTO session_v2 VALUES ('ses_test_1', 'Test Session');")
conn.commit()
conn.close()
`;
  const r = spawnSync("python3", ["-c", py, dbPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `sqlite init failed: ${r.stderr}`);
}

function buildIsolatedSandbox(caseName) {
  const root = path.join(TEST_ROOT, caseName);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const stateDir = path.join(root, "maintenance-state");
  const backupRoot = path.join(root, "backup");
  const candidatePluginDir = path.join(root, "candidate-plugin");
  const candidateHostDir = path.join(root, "candidate-host");
  const releasePluginDir = path.join(root, "plugins/ai-team-v08-b3");
  const liveOptDir = path.join(root, "opt-opencode");
  const liveStagedCli = path.join(root, "desktop-config/cli/2.2.5-x64/opencode-cli");
  const liveOpencodeJson = path.join(root, "opencode-config/opencode.json");
  const liveOpencodeDb = path.join(root, "opencode-data/opencode.db");
  const liveDraftsDb = path.join(root, "desktop-config/drafts.sqlite");
  const livePilotStore = path.join(root, "pilot-store/ai-team-v08-clean");
  const liveServiceJson = path.join(root, "state/service.json");
  const relaunchMarker = path.join(root, "relaunched.txt");
  const relaunchScript = path.join(root, "mock-relaunch.sh");

  for (const d of [
    stateDir,
    path.join(backupRoot, "opt-opencode/resources"),
    path.join(backupRoot, "desktop-config/cli/2.2.5-x64"),
    path.join(backupRoot, "opencode-config"),
    path.join(backupRoot, "opencode-data"),
    path.join(backupRoot, "pilot-store/ai-team-v08-clean/proj1"),
    path.join(candidatePluginDir, "src"),
    path.join(candidatePluginDir, "dist"),
    path.join(candidateHostDir, "resources"),
    path.join(liveOptDir, "resources"),
    path.dirname(liveStagedCli),
    path.dirname(liveOpencodeJson),
    path.dirname(liveOpencodeDb),
    path.join(livePilotStore, "proj1"),
    path.dirname(liveServiceJson),
  ]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  // Original live files
  const origExeContent = "#!/usr/bin/env bash\nsleep 30\n";
  const origAsarContent = "ORIG_LIVE_ASAR_V07";
  const origCliContent = "#!/usr/bin/env bash\nsleep 30\n";
  const origUpdateYml = "provider: github\nurl: https://github.com/anomalyco/opencode\n";
  const origOpencodeJsonContent = JSON.stringify(
    {
      provider: { copilot: { apiKey: "secret-preserve-me" } },
      plugins: [
        {
          package: "/home/hulk/aiteam-dev/owner-inbox",
          options: { officialPilot: true, pilotWake: false, nativeDispatch: false },
        },
      ],
    },
    null,
    2
  );
  const origTeamJsonContent = JSON.stringify(
    {
      teamID: "team_isolated_1",
      mode: "peer",
      members: [{ agent: "Peer 1" }],
      messages: [],
      tasks: [],
    },
    null,
    2
  );

  fs.writeFileSync(path.join(liveOptDir, "ai.opencode"), origExeContent, { mode: 0o755 });
  fs.writeFileSync(path.join(liveOptDir, "resources/app.asar"), origAsarContent, { mode: 0o644 });
  fs.writeFileSync(path.join(liveOptDir, "resources/opencode-cli"), origCliContent, { mode: 0o755 });
  fs.writeFileSync(path.join(liveOptDir, "resources/app-update.yml"), origUpdateYml, { mode: 0o644 });
  fs.writeFileSync(liveStagedCli, origCliContent, { mode: 0o755 });
  fs.writeFileSync(liveOpencodeJson, origOpencodeJsonContent, { mode: 0o600 });
  fs.writeFileSync(path.join(livePilotStore, "proj1/team.json"), origTeamJsonContent, { mode: 0o600 });

  createSqliteDb(liveOpencodeDb);
  createSqliteDb(liveDraftsDb);

  // Copy to backup & create valid SQLite backups
  fs.copyFileSync(path.join(liveOptDir, "ai.opencode"), path.join(backupRoot, "opt-opencode/ai.opencode"));
  fs.copyFileSync(path.join(liveOptDir, "resources/app.asar"), path.join(backupRoot, "opt-opencode/resources/app.asar"));
  fs.copyFileSync(path.join(liveOptDir, "resources/opencode-cli"), path.join(backupRoot, "opt-opencode/resources/opencode-cli"));
  fs.copyFileSync(path.join(liveOptDir, "resources/app-update.yml"), path.join(backupRoot, "opt-opencode/resources/app-update.yml"));
  fs.copyFileSync(liveStagedCli, path.join(backupRoot, "desktop-config/cli/2.2.5-x64/opencode-cli"));
  fs.copyFileSync(liveOpencodeJson, path.join(backupRoot, "opencode-config/opencode.json"));
  fs.copyFileSync(
    path.join(livePilotStore, "proj1/team.json"),
    path.join(backupRoot, "pilot-store/ai-team-v08-clean/proj1/team.json")
  );

  const backupOpencodeDb = path.join(backupRoot, "opencode-data/opencode.db");
  const backupDraftsDb = path.join(backupRoot, "desktop-config/drafts.sqlite");
  createSqliteDb(backupOpencodeDb);
  createSqliteDb(backupDraftsDb);
  spawnSync("python3", [
    "-c",
    `import sqlite3, sys
for p in sys.argv[1:]:
  c = sqlite3.connect(p)
  c.execute("PRAGMA wal_checkpoint(TRUNCATE);")
  c.close()`,
    backupOpencodeDb,
    backupDraftsDb,
  ]);

  // Candidate files
  const candExeContent = origExeContent;
  const candAsarContent = "CANDIDATE_PATCHED_ASAR_B31";
  const candCliContent = "#!/usr/bin/env bash\necho PATCHED_CLI_B31\n";
  const candPkgContent = JSON.stringify({ name: "ai-team-v08-b3", version: "0.8.0" });
  const candIndexContent = "export default function plugin() {}";
  const candCoordContent = "export class OfficialCoordinator {}";
  const candGuiContent = "/* B3.1 COMPACT PEER GUI BUNDLE */";

  fs.writeFileSync(path.join(candidateHostDir, "ai.opencode"), candExeContent, { mode: 0o755 });
  fs.writeFileSync(path.join(candidateHostDir, "resources/app.asar"), candAsarContent, { mode: 0o644 });
  fs.writeFileSync(path.join(candidateHostDir, "resources/opencode-cli"), candCliContent, { mode: 0o755 });
  fs.writeFileSync(path.join(candidatePluginDir, "package.json"), candPkgContent, { mode: 0o644 });
  fs.writeFileSync(path.join(candidatePluginDir, "src/index.ts"), candIndexContent, { mode: 0o644 });
  fs.writeFileSync(path.join(candidatePluginDir, "src/official-coordinator.mjs"), candCoordContent, { mode: 0o644 });
  fs.writeFileSync(path.join(candidatePluginDir, "dist/gui-experimental.cjs"), candGuiContent, { mode: 0o644 });

  // Build manifest
  const manifestFiles = {
    "opt-opencode/ai.opencode": {
      sourcePath: path.join(liveOptDir, "ai.opencode"),
      backupPath: path.join(backupRoot, "opt-opencode/ai.opencode"),
    },
    "opt-opencode/resources/app.asar": {
      sourcePath: path.join(liveOptDir, "resources/app.asar"),
      backupPath: path.join(backupRoot, "opt-opencode/resources/app.asar"),
    },
    "opt-opencode/resources/opencode-cli": {
      sourcePath: path.join(liveOptDir, "resources/opencode-cli"),
      backupPath: path.join(backupRoot, "opt-opencode/resources/opencode-cli"),
    },
    "opt-opencode/resources/app-update.yml": {
      sourcePath: path.join(liveOptDir, "resources/app-update.yml"),
      backupPath: path.join(backupRoot, "opt-opencode/resources/app-update.yml"),
    },
    "desktop-config/cli/2.2.5-x64/opencode-cli": {
      sourcePath: liveStagedCli,
      backupPath: path.join(backupRoot, "desktop-config/cli/2.2.5-x64/opencode-cli"),
    },
    "opencode-config/opencode.json": {
      sourcePath: liveOpencodeJson,
      backupPath: path.join(backupRoot, "opencode-config/opencode.json"),
    },
    "opencode-data/opencode.db": {
      sourcePath: liveOpencodeDb,
      backupPath: backupOpencodeDb,
    },
    "desktop-config/drafts.sqlite": {
      sourcePath: liveDraftsDb,
      backupPath: backupDraftsDb,
    },
    "pilot-store/ai-team-v08-clean/proj1/team.json": {
      sourcePath: path.join(livePilotStore, "proj1/team.json"),
      backupPath: path.join(backupRoot, "pilot-store/ai-team-v08-clean/proj1/team.json"),
    },
  };
  for (const entry of Object.values(manifestFiles)) {
    entry.sha256 = sha256File(entry.backupPath);
    entry.size = fs.statSync(entry.backupPath).size;
  }

  const manifestPath = path.join(backupRoot, "backup-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), files: manifestFiles }, null, 2), {
    mode: 0o600,
  });

  // Mock relaunch command
  fs.writeFileSync(
    relaunchScript,
    `#!/usr/bin/env bash\necho "RELAUNCHED_OK pid=$$" > "${relaunchMarker}"\n`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    B3_ISOLATED_ROOT: root,
    B3_CUTOVER_SCRIPT: CUTOVER_SCRIPT,
    B3_STATE_DIR: stateDir,
    B3_BACKUP_ROOT: backupRoot,
    B3_MANIFEST_PATH: manifestPath,
    B3_CANDIDATE_PLUGIN_DIR: candidatePluginDir,
    B3_CANDIDATE_HOST_DIR: candidateHostDir,
    B3_RELEASE_PLUGIN_DIR: releasePluginDir,
    B3_LIVE_OPT_DIR: liveOptDir,
    B3_LIVE_STAGED_CLI: liveStagedCli,
    B3_LIVE_OPENCODE_JSON: liveOpencodeJson,
    B3_LIVE_OPENCODE_DB: liveOpencodeDb,
    B3_LIVE_DRAFTS_DB: liveDraftsDb,
    B3_LIVE_PILOT_STORE: livePilotStore,
    B3_LIVE_SERVICE_JSON: liveServiceJson,
    B3_FORBID_CGROUP_SUBSTR: "",
    B3_MIN_BACKUP_FILES: "9",
    B3_SUDO_CMD: "",
    B3_POLL_INTERVAL_MS: "150",
    B3_QUIESCENCE_SETTLE_MS: "150",
    B3_MAX_WAIT_MS: "4000",
    B3_RELAUNCH_CMD: relaunchScript,
    B3_EXPECTED_CANDIDATE_EXE_SHA: sha256(candExeContent),
    B3_EXPECTED_CANDIDATE_ASAR_SHA: sha256(candAsarContent),
    B3_EXPECTED_CANDIDATE_CLI_SHA: sha256(candCliContent),
    B3_EXPECTED_CANDIDATE_PKG_SHA: sha256(candPkgContent),
    B3_EXPECTED_CANDIDATE_INDEX_SHA: sha256(candIndexContent),
    B3_EXPECTED_CANDIDATE_COORD_SHA: sha256(candCoordContent),
    B3_EXPECTED_CANDIDATE_GUI_SHA: sha256(candGuiContent),
    B3_ORIG_LIVE_EXE_SHA: sha256(origExeContent),
    B3_ORIG_LIVE_ASAR_SHA: sha256(origAsarContent),
    B3_ORIG_LIVE_CLI_SHA: sha256(origCliContent),
    B3_ORIG_OPENCODE_JSON_SHA: sha256(origOpencodeJsonContent),
  };

  function writeApprovalToken(overrides = {}) {
    const operationId = crypto.randomBytes(32).toString("hex");
    const token = {
      tokenRole: "SINGLE_USE_ARM_MANIFEST_REQUIRING_POLKIT_OWNER_AUTH",
      ownerAuthenticationMechanism: "UBUNTU_POLKIT_PKEXEC_ROOT_BOUNDARY",
      operation: "B3_ONECLICK_CUTOVER",
      operationId,
      consumed: false,
      approvedBy: "Owner",
      approvalScope: "B3_ONECLICK_CUTOVER",
      confirmationPhrase: "YES_I_APPROVE_B3_CUTOVER",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      targetScope: {
        liveOptDir,
        liveStagedCli,
        liveOpencodeJson,
        releasePluginDir,
        livePilotStore,
      },
      pinnedCandidateHashes: {
        exe: env.B3_EXPECTED_CANDIDATE_EXE_SHA,
        asar: env.B3_EXPECTED_CANDIDATE_ASAR_SHA,
        cli: env.B3_EXPECTED_CANDIDATE_CLI_SHA,
        pkg: env.B3_EXPECTED_CANDIDATE_PKG_SHA,
        index: env.B3_EXPECTED_CANDIDATE_INDEX_SHA,
        coord: env.B3_EXPECTED_CANDIDATE_COORD_SHA,
        gui: env.B3_EXPECTED_CANDIDATE_GUI_SHA,
      },
      restrictedModeGates: {
        officialPilot: true,
        pilotWake: false,
        nativeDispatch: false,
      },
      ...overrides,
    };
    fs.writeFileSync(path.join(stateDir, "approval.json"), JSON.stringify(token, null, 2), { mode: 0o600 });
    return token;
  }

  function readStatus() {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
  }

  return {
    root,
    stateDir,
    backupRoot,
    manifestPath,
    candidatePluginDir,
    candidateHostDir,
    releasePluginDir,
    liveOptDir,
    liveStagedCli,
    liveOpencodeJson,
    liveOpencodeDb,
    liveDraftsDb,
    livePilotStore,
    liveServiceJson,
    relaunchMarker,
    env,
    writeApprovalToken,
    readStatus,
  };
}

test("Case 0: Missing Owner approval token blocks helper immediately (exit 4)", () => {
  const sb = buildIsolatedSandbox("case0-unapproved");
  const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
  assert.equal(res.status, 4);
  const st = sb.readStatus();
  assert.equal(st.state, "BLOCKED_UNAPPROVED");
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
});

test("Case 0b: Running inside OpenCode process ancestry blocks helper immediately (exit 2)", () => {
  const sb = buildIsolatedSandbox("case0b-internal-ancestry");
  sb.writeApprovalToken();
  const wrapperExe = path.join(sb.liveOptDir, "ai.opencode");
  fs.writeFileSync(
    wrapperExe,
    `#!/usr/bin/env bash\n"${process.execPath}" "${HELPER_PATH}" --run-once\n`,
    { mode: 0o755 }
  );
  const res = spawnSync(wrapperExe, [], { env: sb.env, encoding: "utf8" });
  assert.equal(res.status, 2);
  const st = sb.readStatus();
  assert.equal(st.state, "BLOCKED_INTERNAL_OPENCODE_SESSION");
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
});

test("Case 0c: setsid process still inside OpenCode systemd cgroup cannot bypass ancestry guard (exit 2)", () => {
  const sb = buildIsolatedSandbox("case0c-setsid-cgroup-bypass-blocked");
  sb.writeApprovalToken();
  const envWithCgroupGuard = {
    ...sb.env,
    B3_FORBID_CGROUP_SUBSTR: "app-ai.opencode.desktop",
  };
  const res = spawnSync("setsid", [process.execPath, HELPER_PATH, "--run-once"], {
    env: envWithCgroupGuard,
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
  const st = sb.readStatus();
  assert.equal(st.state, "BLOCKED_INTERNAL_OPENCODE_SESSION");
  assert.equal(st.ancestryReason, "INTERNAL_OPENCODE_CGROUP");
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
});

test("Case 1: OpenCode Desktop process still running blocks cutover without killing it (exit 3)", () => {
  const sb = buildIsolatedSandbox("case1-opencode-running");
  sb.writeApprovalToken();
  const proc = spawn(path.join(sb.liveOptDir, "ai.opencode"), [], { stdio: "ignore" });
  try {
    const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
    assert.equal(res.status, 3);
    const st = sb.readStatus();
    assert.equal(st.state, "BLOCKED_OPENCODE_RUNNING");
    assert.ok(st.quiescence.activeOpenCodeProcs.some((p) => p.pid === proc.pid));
    assert.equal(fs.existsSync(`/proc/${proc.pid}`), true);
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
    assert.equal(fs.existsSync(sb.relaunchMarker), false);
  } finally {
    proc.kill("SIGTERM");
  }
});

test("Case 2: Active native session on sidecar API blocks cutover without canceling session (exit 3)", async () => {
  const sb = buildIsolatedSandbox("case2-active-session");
  sb.writeApprovalToken();

  const server = http.createServer((req, res) => {
    if (req.url === "/api/session/active") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ses_live_running_1: { type: "running" } } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  fs.writeFileSync(
    sb.liveServiceJson,
    JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }),
    { mode: 0o600 }
  );

  try {
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(res.status, 3);
    const st = sb.readStatus();
    assert.equal(st.state, "BLOCKED_ACTIVE_SESSION");
    assert.deepEqual(st.quiescence.activeSessionIds, ["ses_live_running_1"]);
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
    assert.equal(fs.existsSync(sb.relaunchMarker), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("Case 3: Open SQLite FD (opencode.db / drafts.sqlite) blocks cutover (exit 3)", () => {
  const sb = buildIsolatedSandbox("case3-sqlite-fd-open");
  sb.writeApprovalToken();

  const holder = spawn(
    "python3",
    ["-c", "import sys, time; f = open(sys.argv[1], 'r+b'); time.sleep(30)", sb.liveOpencodeDb],
    { stdio: "ignore" }
  );
  spawnSync("sleep", ["0.2"]);

  try {
    const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
    assert.equal(res.status, 3);
    const st = sb.readStatus();
    assert.equal(st.state, "BLOCKED_SQLITE_OR_BINARY_FD_OPEN");
    assert.ok(st.quiescence.openTargetFds.some((fd) => fd.pid === holder.pid));
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
    assert.equal(fs.existsSync(sb.relaunchMarker), false);
  } finally {
    holder.kill("SIGTERM");
  }
});

test("Case 4: Invalid/corrupted backup manifest blocks cutover before any modification (exit 6)", () => {
  const sb = buildIsolatedSandbox("case4-invalid-backup");
  sb.writeApprovalToken();
  fs.writeFileSync(path.join(sb.backupRoot, "opt-opencode/resources/app.asar"), "CORRUPTED_BACKUP_DATA");

  const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
  assert.equal(res.status, 6);
  const st = sb.readStatus();
  assert.equal(st.state, "ABORTED_PRECHECK_FAILED");
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
  assert.equal(fs.existsSync(sb.relaunchMarker), false);
});

test("Case 5: Candidate artifact SHA-256 mismatch blocks cutover before any modification (exit 6)", () => {
  const sb = buildIsolatedSandbox("case5-candidate-hash-mismatch");
  sb.writeApprovalToken();
  fs.writeFileSync(path.join(sb.candidatePluginDir, "dist/gui-experimental.cjs"), "TAMPERED_GUI_BUNDLE");

  const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
  assert.equal(res.status, 6);
  const st = sb.readStatus();
  assert.equal(st.state, "ABORTED_PRECHECK_FAILED");
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
  assert.equal(fs.existsSync(sb.relaunchMarker), false);
});

test("Case 6: Post-cutover verification failure triggers automatic rollback and does NOT relaunch (exit 7)", () => {
  const sb = buildIsolatedSandbox("case6-cutover-fail-rollback");
  sb.writeApprovalToken();

  const envWithFault = {
    ...sb.env,
    B3_POST_APPLY_FAULT_INJECT: "corrupt_after_apply",
  };
  const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: envWithFault, encoding: "utf8" });
  assert.equal(res.status, 7);
  const st = sb.readStatus();
  assert.equal(st.state, "ROLLED_BACK_AFTER_FAILURE");
  assert.equal(st.rollbackOk, true);

  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/opencode-cli")), sb.env.B3_ORIG_LIVE_CLI_SHA);
  assert.equal(sha256File(sb.liveStagedCli), sb.env.B3_ORIG_LIVE_CLI_SHA);
  assert.equal(fs.existsSync(path.join(sb.liveOptDir, "resources/app-update.yml")), true);
  const restoredCfg = JSON.parse(fs.readFileSync(sb.liveOpencodeJson, "utf8"));
  assert.equal(restoredCfg.plugins[0].package, "/home/hulk/aiteam-dev/owner-inbox");
  assert.equal(fs.existsSync(sb.relaunchMarker), false);
});

test.skip("Case 7: Legacy arm success withdrawn: arming disabled pending security acceptance", async () => {
  const sb = buildIsolatedSandbox("case7-detached-systemd-success");
  const envWithCgroupGuard = {
    ...sb.env,
    B3_FORBID_CGROUP_SUBSTR: "app-ai.opencode.desktop",
  };

  const desktopProc = spawn(path.join(sb.liveOptDir, "ai.opencode"), [], { stdio: "ignore" });
  try {
    const armRes = spawnSync(
      process.execPath,
      [HELPER_PATH, "--arm", "--confirm=YES_I_APPROVE_B3_CUTOVER"],
      { env: envWithCgroupGuard, encoding: "utf8" }
    );
    assert.equal(armRes.status, 0, `arm failed: ${armRes.stderr}`);
    const armInfo = JSON.parse(armRes.stdout);
    assert.equal(armInfo.armed, true);
    assert.equal(armInfo.spawnedVia, "systemd-run");
    assert.match(armInfo.systemdUnit, /^b3-oneclick-helper-[a-f0-9]{12}\.service$/);
    assert.equal(armInfo.operationId.length, 64);

    // Wait 450ms: helper should be in WAITING_FOR_QUIESCENCE and live files still untouched
    await new Promise((r) => setTimeout(r, 450));
    const midStatus = sb.readStatus();
    assert.equal(midStatus.state, "WAITING_FOR_QUIESCENCE");
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);

    // Simulate Owner closing OpenCode Desktop cleanly
    desktopProc.kill("SIGTERM");

    let finalStatus = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 150));
      finalStatus = sb.readStatus();
      if (
        finalStatus.state === "COMPLETED_SUCCESS" ||
        finalStatus.state.startsWith("ABORTED") ||
        finalStatus.state.startsWith("ROLLED_BACK")
      ) {
        break;
      }
    }
    assert.equal(finalStatus.state, "COMPLETED_SUCCESS", `Unexpected final status: ${JSON.stringify(finalStatus)}`);
    assert.equal(finalStatus.polkitAuthResult, "AUTHENTICATED_OK");
    assert.equal(finalStatus.polkitReceipt.operationId, armInfo.operationId);

    // Verify replaced binaries & staged plugin hashes
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_EXPECTED_CANDIDATE_ASAR_SHA);
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/opencode-cli")), sb.env.B3_EXPECTED_CANDIDATE_CLI_SHA);
    assert.equal(sha256File(sb.liveStagedCli), sb.env.B3_EXPECTED_CANDIDATE_CLI_SHA);
    assert.equal(sha256File(path.join(sb.releasePluginDir, "dist/gui-experimental.cjs")), sb.env.B3_EXPECTED_CANDIDATE_GUI_SHA);
    assert.equal(fs.existsSync(path.join(sb.liveOptDir, "resources/app-update.yml")), false);
    assert.equal(fs.existsSync(path.join(sb.liveOptDir, "resources/app-update.yml.disabled-b3")), true);

    // Verify opencode.json restricted gates and preserved secret
    const updatedCfg = JSON.parse(fs.readFileSync(sb.liveOpencodeJson, "utf8"));
    assert.equal(updatedCfg.provider.copilot.apiKey, "secret-preserve-me");
    assert.equal(updatedCfg.plugins[0].package, sb.releasePluginDir);
    assert.deepEqual(updatedCfg.plugins[0].options, {
      officialPilot: true,
      pilotWake: false,
      nativeDispatch: false,
      pilotStore: sb.livePilotStore,
    });

    assert.equal(fs.existsSync(sb.relaunchMarker), true);
  } finally {
    try {
      desktopProc.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
});

test.skip("Case 8: Legacy arm/replay coverage withdrawn: trusted root ledger not implemented", async () => {
  const sb = buildIsolatedSandbox("case8-double-arm-and-replay");
  const desktopProc = spawn(path.join(sb.liveOptDir, "ai.opencode"), [], { stdio: "ignore" });
  try {
    // 1. First --arm succeeds
    const arm1 = spawnSync(
      process.execPath,
      [HELPER_PATH, "--arm", "--confirm=YES_I_APPROVE_B3_CUTOVER"],
      { env: sb.env, encoding: "utf8" }
    );
    assert.equal(arm1.status, 0);
    const arm1Info = JSON.parse(arm1.stdout);
    await new Promise((r) => setTimeout(r, 300));

    // 2. Second --arm while first helper is waiting is rejected (exit 5)
    const arm2 = spawnSync(
      process.execPath,
      [HELPER_PATH, "--arm", "--confirm=YES_I_APPROVE_B3_CUTOVER"],
      { env: sb.env, encoding: "utf8" }
    );
    assert.equal(arm2.status, 5);
    assert.match(arm2.stderr, /BLOCKED_ALREADY_ARMED_OR_RUNNING/);

    // 3. Let first helper finish cleanly
    desktopProc.kill("SIGTERM");
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (sb.readStatus().state === "COMPLETED_SUCCESS") break;
    }
    assert.equal(sb.readStatus().state, "COMPLETED_SUCCESS");

    // 4. Verify approval.json is marked consumed: true and replay via --run-once is rejected (exit 4)
    const consumedApproval = JSON.parse(fs.readFileSync(path.join(sb.stateDir, "approval.json"), "utf8"));
    assert.equal(consumedApproval.consumed, true);
    assert.equal(consumedApproval.operationId, arm1Info.operationId);

    // Even if someone tampers with approval.json to flip consumed back to false, consumed-operations.json blocks replay
    consumedApproval.consumed = false;
    fs.writeFileSync(path.join(sb.stateDir, "approval.json"), JSON.stringify(consumedApproval, null, 2), { mode: 0o600 });

    const replayRes = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], { env: sb.env, encoding: "utf8" });
    assert.equal(replayRes.status, 4);
    assert.equal(sb.readStatus().state, "BLOCKED_UNAPPROVED");
    assert.equal(sb.readStatus().reason, "APPROVAL_TOKEN_ALREADY_CONSUMED_OR_REPLAYED");
  } finally {
    try {
      desktopProc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
});

test("Case 9: Polkit Owner authentication denial/cancel aborts BEFORE any live or user-owned file is modified (exit 8)", () => {
  const sb = buildIsolatedSandbox("case9-polkit-denied");
  sb.writeApprovalToken();

  // Mock pkexec cancelling with exit code 126 (Owner clicked Cancel on Ubuntu Polkit dialog)
  const mockPkexecCancel = path.join(sb.root, "mock-pkexec-cancel.sh");
  fs.writeFileSync(mockPkexecCancel, "#!/usr/bin/env bash\nexit 126\n", { mode: 0o755 });

  const envWithCancelledPolkit = {
    ...sb.env,
    B3_SUDO_CMD: mockPkexecCancel,
  };
  const res = spawnSync(process.execPath, [HELPER_PATH, "--run-once"], {
    env: envWithCancelledPolkit,
    encoding: "utf8",
  });
  assert.equal(res.status, 8);
  const st = sb.readStatus();
  assert.equal(st.state, "ABORTED_POLKIT_AUTH_CANCELLED_OR_FAILED");
  assert.equal(st.polkitAuthResult, "DENIED_OR_CANCELLED");

  // Verify ZERO files were modified anywhere (not /opt/OpenCode, not staged CLI, not opencode.json, not releasePluginDir)
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
  assert.equal(sha256File(path.join(sb.liveOptDir, "resources/opencode-cli")), sb.env.B3_ORIG_LIVE_CLI_SHA);
  assert.equal(sha256File(sb.liveStagedCli), sb.env.B3_ORIG_LIVE_CLI_SHA);
  assert.equal(sha256File(sb.liveOpencodeJson), sb.env.B3_ORIG_OPENCODE_JSON_SHA);
  assert.equal(fs.existsSync(sb.releasePluginDir), false);
  assert.equal(fs.existsSync(sb.relaunchMarker), false);

  // Verify token was consumed so it cannot linger
  const postApproval = JSON.parse(fs.readFileSync(path.join(sb.stateDir, "approval.json"), "utf8"));
  assert.equal(postApproval.consumed, true);
});

test("Case 10: Desktop window closed while sidecar continues running waits passively and stops safely on timeout without killing sidecar (exit 3)", async () => {
  const sb = buildIsolatedSandbox("case10-window-closed-sidecar-running");
  sb.writeApprovalToken();

  // Start both Desktop (ai.opencode) and Sidecar (liveStagedCli)
  const desktopProc = spawn(path.join(sb.liveOptDir, "ai.opencode"), [], { stdio: "ignore" });
  const sidecarProc = spawn(sb.liveStagedCli, ["serve", "--service"], { stdio: "ignore" });

  try {
    const shortTimeoutEnv = {
      ...sb.env,
      B3_MAX_WAIT_MS: "900",
      B3_POLL_INTERVAL_MS: "150",
    };

    const daemonPromise = new Promise((resolve) => {
      const child = spawn(process.execPath, [HELPER_PATH, "--daemon"], { env: shortTimeoutEnv });
      child.on("close", (status) => resolve({ status }));
    });

    // Wait 250ms, then simulate Owner closing the Desktop window while sidecar stays running
    await new Promise((r) => setTimeout(r, 250));
    desktopProc.kill("SIGTERM");

    const daemonRes = await daemonPromise;
    assert.equal(daemonRes.status, 3);
    const st = sb.readStatus();
    assert.equal(st.state, "TIMED_OUT_WAITING_FOR_QUIESCENCE");
    assert.equal(st.blockReason, "BLOCKED_SIDECAR_STILL_RUNNING");

    // Verify sidecar was NEVER killed and NO live files were modified
    assert.equal(fs.existsSync(`/proc/${sidecarProc.pid}`), true);
    assert.equal(sha256File(path.join(sb.liveOptDir, "resources/app.asar")), sb.env.B3_ORIG_LIVE_ASAR_SHA);
    assert.equal(sha256File(sb.liveOpencodeJson), sb.env.B3_ORIG_OPENCODE_JSON_SHA);
    assert.equal(fs.existsSync(sb.relaunchMarker), false);
  } finally {
    try {
      desktopProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    try {
      sidecarProc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
});
