import {constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, parse} from 'node:path';

export const OWNER_GRANT_MAX_AGE_MS = 60_000;
const fail = () => { throw Error('PILOT_OWNER_GRANT_INVALID'); };

// Local pilot boundary, NOT authentication against code running as the same OS user.
// Main-only: call issueOwnerGrant AFTER native confirmation on Caller.window, checking
// sameMachine and live canonical project identity before AND after the dialog. Never
// expose issuance via server RPC, tools, renderer imports, config, or plugin options.
// Server: pass its own ctx.location.project.{canonical,id}, not request identity.
// Token is a short-lived bearer capability: authenticated local transport only; never log.
// ponytail: shared-UID local pilot only; use a separate OS principal/host transport for hostile workers.
function store() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) fail();
  const home = homedir();
  if (!isAbsolute(home) || realpathSync(home) !== home) fail();
  for (let path = home;; path = dirname(path)) {
    const stat = lstatSync(path);
    // Root-owned sticky temp ancestors allow isolated HOME fixtures; private children
    // cannot be replaced by other users. No other writable ancestor is accepted.
    const sticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        ![0, process.getuid()].includes(stat.uid) || ((stat.mode & 0o022) && !sticky)) fail();
    if (path === parse(path).root) break;
  }
  const path = join(home, '.opencode-pilot-owner-authority');
  try { mkdirSync(path, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) fail();
  return path;
}

function scope(input) {
  if (!input || !['createTeam','ownerMessage','ownerPlan','cancelExecution','integrateTask'].includes(input.operation) || typeof input.projectID !== 'string' ||
      !input.projectID || input.projectID.length > 256 || /[\x00-\x1f\x7f]/.test(input.projectID) ||
      typeof input.root !== 'string' || !isAbsolute(input.root) || input.root.includes('\0') ||
      realpathSync(input.root) !== input.root) fail();
  const stat = lstatSync(input.root);
  if (!stat.isDirectory()) fail();
  const bound=input.generation!==undefined||input.requestID!==undefined||input.planHash!==undefined;
  if(bound&&(!/^[a-z0-9-]{1,80}$/.test(input.generation??'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestID??'')||!/^[a-f0-9]{64}$/.test(input.planHash??'')))fail();
  return {operation: input.operation, root: input.root, projectID: input.projectID, dev: stat.dev, ino: stat.ino,...(bound?{generation:input.generation,requestID:input.requestID,planHash:input.planHash}:{})};
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function filename(directory, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail();
  return join(directory, createHash('sha256').update(token).digest('hex') + '.json');
}

/** Main-process only. Returns opaque token, never an Owner/member context. */
export function issueOwnerGrant(input, {signal} = {}) {
  signal?.throwIfAborted();
  const binding = scope(input);
  const directory = store();
  const token = randomBytes(32).toString('base64url');
  const file = filename(directory, token);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({...binding, issuedAt: Date.now()}));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(directory);
  if (signal?.aborted) { unlinkSync(file); syncDirectory(directory); signal.throwIfAborted(); }
  return token;
}

/** Server only. Consume before provisioning; failed/crashed provisioning needs new approval. */
export function consumeOwnerGrant(token, input) {
  try {
    const expected = scope(input);
    const directory = store();
    const file = filename(directory, token);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let grant;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 || stat.size > 4096) fail();
      grant = JSON.parse(readFileSync(fd, 'utf8'));
      const named = lstatSync(file);
      if (named.dev !== stat.dev || named.ino !== stat.ino || named.isSymbolicLink()) fail();
    } finally { closeSync(fd); }
    if (!grant || Object.keys(grant).sort().join(',') !== [...Object.keys(expected),'issuedAt'].sort().join(',') ||
        Object.entries(expected).some(([key, value]) => grant[key] !== value) ||
        !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt > Date.now() ||
        Date.now() - grant.issuedAt >= OWNER_GRANT_MAX_AGE_MS) fail();
    // Atomic unlink elects one winner across processes. No state recreation on replay.
    // Directory fsync must succeed before any privileged side effect is admitted.
    unlinkSync(file);
    syncDirectory(directory);
    return true;
  } catch { fail(); }
}
