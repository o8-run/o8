import { childEnvironment } from '@/lib/providers/spawn-environment';
import { hasCloseProcessObservation, settleCloseObservedHelper } from '@/lib/runtime/close-process-observation';
import { spawn } from '@/lib/providers/child-process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { readProcessCwdSnapshot, type ProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { removeExactEmptyChildDirectory } from './exact-parent-operation';

const capturedPurgeBrand: unique symbol = Symbol('captured-purge');
export interface CapturedPurgeProcessWitness { readonly [capturedPurgeBrand]: true }
const capturedPurgeProcesses = new WeakMap<CapturedPurgeProcessWitness, {
  pid: number;
  identity: MetadataLockProcessIdentity;
  candidatePath: string;
  device: number;
  inode: number;
  namespace: PurgeNamespace;
}>();
type AfterTreeCapture = (candidatePath: string, witness: CapturedPurgeProcessWitness) => Promise<void>;

interface PurgeNamespace {
  requestedPath: string;
  canonicalPath: string;
  parentIdentity: { device: number; inode: number; canonicalPath: string };
  ancestors: Array<{ path: string; device: number; inode: number; symlink: boolean }>;
}

async function assertPurgeNamespace(
  namespace: PurgeNamespace,
  identity: { device: number; inode: number },
): Promise<void> {
  for (const parent of [path.dirname(namespace.requestedPath), namespace.parentIdentity.canonicalPath]) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== namespace.parentIdentity.device || stat.ino !== namespace.parentIdentity.inode) {
      throw new Error('Exact purge parent ownership changed after admission.');
    }
  }
  for (const candidate of [namespace.requestedPath, namespace.canonicalPath]) {
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.device || stat.ino !== identity.inode
      || await realpath(candidate) !== namespace.canonicalPath) {
      throw new Error('Exact purge captured an unexpected directory identity.');
    }
  }
  for (const ancestor of namespace.ancestors) {
    const stat = await lstat(ancestor.path);
    if (stat.dev !== ancestor.device || stat.ino !== ancestor.inode
      || stat.isSymbolicLink() !== ancestor.symlink
      || (!stat.isDirectory() && !stat.isSymbolicLink())) {
      throw new Error('Exact purge ancestor namespace changed after admission.');
    }
  }
  if (await realpath(path.dirname(namespace.requestedPath)) !== namespace.parentIdentity.canonicalPath) {
    throw new Error('Exact purge parent namespace changed after admission.');
  }
}

async function capturePurgeNamespace(
  candidatePath: string,
  identity: { device: number; inode: number },
): Promise<PurgeNamespace> {
  const requestedPath = path.resolve(candidatePath);
  const parentPath = path.dirname(requestedPath);
  const parentStat = await lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Exact purge parent is not a regular directory.');
  }
  const canonicalParent = await realpath(parentPath);
  // Pin the lexical alias and canonical ancestry before invoking caller hooks.
  // A replacement alias, even one targeting the same inode, is new authority.
  const namespace: PurgeNamespace = {
    requestedPath,
    canonicalPath: path.join(canonicalParent, path.basename(requestedPath)),
    parentIdentity: { device: parentStat.dev, inode: parentStat.ino, canonicalPath: canonicalParent },
    ancestors: [],
  };
  const ancestors = new Set<string>();
  for (const parent of [parentPath, canonicalParent]) {
    let ancestor = parent;
    while (true) {
      ancestors.add(ancestor);
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }
  for (const ancestor of ancestors) {
    const stat = await lstat(ancestor);
    namespace.ancestors.push({ path: ancestor, device: stat.dev, inode: stat.ino,
      symlink: stat.isSymbolicLink() });
  }
  await assertPurgeNamespace(namespace, identity);
  return namespace;
}

/** Only the currently paused, birth-verified native helper may be excluded. */
export async function readCapturedPurgeCwdSnapshot(
  witness: CapturedPurgeProcessWitness,
  scopePath: string,
): Promise<ProcessCwdSnapshot> {
  const captured = capturedPurgeProcesses.get(witness);
  const scope = await realpath(path.resolve(scopePath));
  if (!captured || scope === path.parse(scope).root
    || (captured.candidatePath !== scope && !captured.candidatePath.startsWith(scope + path.sep))) {
    throw new Error('Purge process witness is not live authority for this workspace.');
  }
  await assertPurgeNamespace(captured.namespace, captured);
  const stat = await lstat(captured.candidatePath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== captured.device
    || stat.ino !== captured.inode || await realpath(captured.candidatePath) !== captured.candidatePath) {
    throw new Error('Captured purge namespace changed during the process probe.');
  }
  // Close callers explicitly refresh after readers settle at the paused seam.
  // Its bracketed helper checks share that generation; other callers force a
  // native read on each check rather than relying on the inventory cache.
  const snapshot = await readProcessCwdSnapshot({ forceRefresh: !hasCloseProcessObservation() });
  const probe = await probeMetadataLockProcessIdentity(captured.pid);
  if (snapshot.status !== 'ready' || probe.state !== 'live'
    || !sameMetadataLockProcessIdentity(probe.identity, captured.identity)
    || capturedPurgeProcesses.get(witness) !== captured) {
    throw new Error('Captured purge process truth is unknown or no longer live.');
  }
  await assertPurgeNamespace(captured.namespace, captured);
  const rows = snapshot.rows.filter(row => row.pid === captured.pid);
  if (rows.length !== 1 || path.resolve(rows[0].cwd) !== captured.candidatePath) {
    throw new Error('Captured purge process has no exact native cwd observation.');
  }
  return { ...snapshot, rows: snapshot.rows.filter(row => row.pid !== captured.pid) };
}

/** Scoped exclusion for this exact live, paused helper, never a PID allowlist. */
export async function withCapturedPurgeProcessExclusion<T>(
  witness: CapturedPurgeProcessWitness,
  candidatePath: string,
  operation: (isHelper: (pid: number) => boolean) => Promise<T>,
): Promise<T> {
  const captured = capturedPurgeProcesses.get(witness);
  if (!captured || path.resolve(candidatePath) !== captured.candidatePath) {
    throw new Error('Purge helper exclusion has no exact candidate authority.');
  }
  await readCapturedPurgeCwdSnapshot(witness, candidatePath);
  let active = true;
  try {
    const result = await operation((pid) => active
      && capturedPurgeProcesses.get(witness) === captured && pid === captured.pid);
    await readCapturedPurgeCwdSnapshot(witness, candidatePath);
    return result;
  } finally { active = false; }
}

export interface ExactDirectoryManifestEntry {
  relative: string;
  device: number;
  inode: number;
  kind: 'directory' | 'symlink' | 'file' | 'other';
  mode: number;
  linkCount: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  contentSha256?: string;
  symlinkTarget?: string;
}

export interface ExactDirectoryManifest {
  fingerprint: string;
  entries: ExactDirectoryManifestEntry[];
}

const PURGE_CAPTURE_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
let rootCanonical;
const directories = [];
const sealBuffer = process.env.O8_PURGE_CAPTURE_CONTENTS === '1' ? Buffer.allocUnsafe(1024 * 1024) : null;
let sealBytes = 0;
let phase = 'capture';
let phaseStarted = Date.now();
function progress(entries, done = false) {
  if (done || entries % 128 === 0) process.stdout.write('O8_PURGE_PROGRESS '
    + JSON.stringify({ phase, entries, elapsedMs: Date.now() - phaseStarted, done }) + '\n');
}
function beginPhase(name) {
  phase = name; phaseStarted = Date.now(); progress(0);
}

function verifyLocation() {
  for (const directory of directories) {
    const named = fs.lstatSync(path.join(rootCanonical, directory.relative));
    const pinned = fs.fstatSync(directory.handle.fd);
    if (!sameNamespaceIdentity(named, directory.entry) || named.isSymbolicLink()
      || !sameNamespaceIdentity(pinned, directory.entry)) {
      throw new Error('Exact purge directory component changed after open.');
    }
  }
  const current = directories[directories.length - 1];
  if (!sameNamespaceIdentity(fs.lstatSync('.'), current.entry)
    || fs.realpathSync('.') !== path.join(rootCanonical, current.relative)
    || (directories.length > 1 && !sameNamespaceIdentity(fs.lstatSync('..'), directories[directories.length - 2].entry))) {
    throw new Error('Exact purge captured directory left its verified root.');
  }
}

// Node has no openat/fchdir API. Enter one no-follow-opened component at a
// time in this isolated helper, then re-verify both cwd and the named inode.
// Keep the verified common ancestors open between siblings. Reopening the
// entire chain for every leaf makes broad, deep build output quadratic in depth.
// Every leaf syscall still uses a single name in a freshly attested cwd.
async function inDirectory(relative, expectedByPath, operation) {
  const parts = relative === '.' ? [] : relative.split(path.sep);
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Exact purge refused an unsafe component.');
  verifyLocation();
  let common = 0;
  while (common < parts.length && common + 1 < directories.length
    && directories[common + 1].relative === path.join(...parts.slice(0, common + 1))) common++;
  while (directories.length > common + 1) {
    const current = directories[directories.length - 1];
    verifyLocation();
    process.chdir('..');
    directories.pop();
    try { verifyLocation(); } finally { await current.handle.close(); }
  }
  for (let index = common; index < parts.length; index++) {
    verifyLocation();
    const part = parts[index];
    const childRelative = path.join(directories[directories.length - 1].relative, part);
    const expected = expectedByPath.get(childRelative);
    const before = await fsp.lstat(part);
    if (!expected || expected.kind !== 'directory' || !sameNamespaceIdentity(before, expected)) {
      throw new Error('Exact purge ancestor is not its captured directory.');
    }
    const handle = await fsp.open(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      verifyLocation();
      if (!sameNamespaceIdentity(await handle.stat(), expected)
        || !sameNamespaceIdentity(await fsp.lstat(part), expected)) {
        throw new Error('Exact purge ancestor identity changed before entry.');
      }
      process.chdir(part);
      directories.push({ relative: childRelative, entry: expected, handle });
      verifyLocation();
    } catch (error) { await handle.close(); throw error; }
  }
  try { return await operation(); }
  finally { verifyLocation(); }
}

function sameFileRevision(actual, expected, links = expected.linkCount) {
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.mode === expected.mode
    && (links !== expected.linkCount || actual.ctimeMs === expected.ctimeMs);
}

async function manifestAt() {
  const entries = [];
  const byPath = new Map([[ '.', directories[0].entry ]]);
  const pending = ['.'];
  while (pending.length > 0) {
    const relative = pending.pop();
    const stat = await inDirectory(path.dirname(relative), byPath, () => fsp.lstat(path.basename(relative)));
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const entry = {
      relative,
      device: stat.dev,
      inode: stat.ino,
      kind,
      mode: stat.mode,
      linkCount: stat.nlink,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    if (process.env.O8_PURGE_CAPTURE_CONTENTS === '1' && kind === 'file') {
      sealBytes += stat.size;
      if (sealBytes > 4 * 1024 ** 3) throw new Error('Warm seal byte budget exceeded.');
      entry.contentSha256 = await inDirectory(path.dirname(relative), byPath, async () => {
        const handle = await fsp.open(path.basename(relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const before = await handle.stat();
          if (!sameIdentity(before, entry) || !sameFileRevision(before, entry) || before.nlink !== entry.linkCount) throw new Error('Sealed file changed before reading.');
          const hash = crypto.createHash('sha256');
          const buffer = sealBuffer;
          let read = 0;
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            read += bytesRead;
            if (read > before.size) throw new Error('Sealed file grew while reading.');
            hash.update(buffer.subarray(0, bytesRead));
          }
          const after = await handle.stat();
          const named = await fsp.lstat(path.basename(relative));
          if (read !== before.size || !sameIdentity(after, entry) || !sameFileRevision(after, entry) || after.nlink !== entry.linkCount
            || !sameIdentity(named, entry) || !sameFileRevision(named, entry)) throw new Error('Sealed file changed while reading.');
          return hash.digest('hex');
        } finally { await handle.close(); }
      });
    } else if (process.env.O8_PURGE_CAPTURE_CONTENTS === '1' && kind === 'symlink') {
      entry.symlinkTarget = await inDirectory(path.dirname(relative), byPath, () => fsp.readlink(path.basename(relative)));
    }
    entries.push(entry);
    if (sealBuffer && entries.length > 262144) throw new Error('Warm seal entry budget exceeded.');
    progress(entries.length);
    byPath.set(relative, entry);
    if (kind === 'directory') {
      const names = (await inDirectory(relative, byPath, () => fsp.readdir('.'))).sort().reverse();
      for (const name of names) pending.push(path.join(relative, name));
    }
  }
  await inDirectory('.', byPath, async () => {});
  progress(entries.length, true);
  return entries;
}

function inodeKey(entry) {
  return entry.kind === 'file' ? entry.device + ':' + entry.inode : '';
}

function countFileNames(manifest) {
  const counts = new Map();
  for (const entry of manifest) {
    if (entry.kind !== 'file') continue;
    const key = inodeKey(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function childNamesByParent(manifest) {
  const names = new Map();
  for (const entry of manifest) {
    if (entry.relative === '.') continue;
    const parent = path.dirname(entry.relative);
    const children = names.get(parent) || [];
    children.push(path.basename(entry.relative));
    names.set(parent, children);
  }
  for (const children of names.values()) children.sort();
  return names;
}

function sameIdentity(actual, expected) {
  const kind = actual.isSymbolicLink() ? 'symlink' : actual.isDirectory() ? 'directory' : actual.isFile() ? 'file' : 'other';
  return actual.dev === expected.device && actual.ino === expected.inode && kind === expected.kind
    && (kind !== 'file' || actual.nlink === expected.linkCount);
}

function sameNamespaceIdentity(actual, expected) {
  const kind = actual.isSymbolicLink() ? 'symlink' : actual.isDirectory() ? 'directory' : actual.isFile() ? 'file' : 'other';
  return actual.dev === expected.device && actual.ino === expected.inode && kind === expected.kind;
}

function verifyMonotonicManifest(current, expected) {
  const expectedByPath = new Map(expected.map((entry) => [entry.relative, entry]));
  const currentPaths = new Set(current.map((entry) => entry.relative));
  const expectedFileNames = countFileNames(expected);
  const currentFileNames = countFileNames(current);
  for (const actual of current) {
    const prior = expectedByPath.get(actual.relative);
    if (!prior || actual.device !== prior.device || actual.inode !== prior.inode
      || actual.kind !== prior.kind) {
      throw new Error('Exact purge tree is not a monotonic subset of its durable manifest.');
    }
    if (actual.kind === 'file') {
      const key = inodeKey(prior);
      const originalNames = expectedFileNames.get(key) || 0;
      const remainingNames = currentFileNames.get(key) || 0;
      if (actual.linkCount !== prior.linkCount - (originalNames - remainingNames)) {
        throw new Error('Exact purge file link identity changed outside monotonic namespace release.');
      }
      if (!sameFileRevision(actual, prior, actual.linkCount)) {
        throw new Error('Exact purge file contents changed after its durable manifest.');
      }
    }
    let parent = path.dirname(actual.relative);
    while (parent !== '.' && parent !== actual.relative) {
      if (!currentPaths.has(parent)) {
        throw new Error('Exact purge durable manifest has a detached descendant.');
      }
      parent = path.dirname(parent);
    }
  }
}

async function releaseContent(manifest) {
  // Preflight the entire tree before unlinking anything. Never chmod or
  // truncate: another name or an already-open descriptor may own those bytes.
  if (manifest.some((entry) => entry.kind === 'other')) {
    throw new Error('Exact purge refuses non-file workspace entries.');
  }
  const preserveUnlisted = process.env.O8_PURGE_PRESERVE_UNLISTED === '1';
  const expectedChildNames = childNamesByParent(manifest);
  const byPath = new Map(manifest.map(entry => [entry.relative, entry]));
  beginPhase('preflight');
  let checked = 0;
  for (const expected of manifest) {
    await inDirectory(path.dirname(expected.relative), byPath, async () => {
      const actual = await fsp.lstat(path.basename(expected.relative));
      if (!sameIdentity(actual, expected)) throw new Error('Exact purge tree identity changed after capture.');
      if (expected.kind === 'file' && !sameFileRevision(actual, expected)) {
        throw new Error('Exact purge file contents changed after capture.');
      }
    });
    if (expected.kind === 'directory') {
      const actualNames = (await inDirectory(expected.relative, byPath, () => fsp.readdir('.'))).sort();
      const expectedNames = expectedChildNames.get(expected.relative) || [];
      if (JSON.stringify(preserveUnlisted ? actualNames.filter(name => expectedNames.includes(name)) : actualNames) !== JSON.stringify(expectedNames)) {
        throw new Error('Exact purge directory entries changed after capture.');
      }
    }
    progress(++checked);
  }
  progress(checked, true);
  beginPhase('release');
  const releasedNames = new Map();
  let releasedEntries = 0;
  for (const expected of [...manifest].reverse()) {
    if (expected.relative === '.') continue;
    await inDirectory(path.dirname(expected.relative), byPath, async () => {
      const name = path.basename(expected.relative);
      const key = inodeKey(expected);
      const links = expected.linkCount - (releasedNames.get(key) || 0);
      const handle = expected.kind === 'file'
        ? await fsp.open(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) : null;
      try {
        verifyLocation();
        const actual = fs.lstatSync(name);
        if (!sameNamespaceIdentity(actual, expected)
          || (handle && (actual.nlink !== links || !sameFileRevision(actual, expected, links)
            || !sameNamespaceIdentity(fs.fstatSync(handle.fd), expected)
            || !sameFileRevision(fs.fstatSync(handle.fd), expected, links)))) {
          throw new Error('Exact purge tree identity or file contents changed before namespace release.');
        }
        const final = fs.lstatSync(name);
        if (!sameNamespaceIdentity(final, expected)
          || (handle && (final.nlink !== links || !sameFileRevision(final, expected, links)))) {
          throw new Error('Exact purge file changed during descriptor verification.');
        }
        verifyLocation();
        if (expected.kind === 'directory') {
          if (!preserveUnlisted || fs.readdirSync(name).length === 0) fs.rmdirSync(name);
        }
        else fs.unlinkSync(name);
        if (handle) releasedNames.set(key, (releasedNames.get(key) || 0) + 1);
      } finally { if (handle) await handle.close(); }
    });
    releasedEntries += 1;
    progress(releasedEntries);
    if (releasedEntries === 1 && process.env.NODE_ENV === 'test'
      && process.env.O8_TEST_PURGE_STOP_MARKER) {
      fs.writeFileSync(process.env.O8_TEST_PURGE_STOP_MARKER, expected.relative, { flag: 'wx' });
      process.kill(process.pid, 'SIGSTOP');
    }
  }
  if (!preserveUnlisted && (await fsp.readdir('.')).length !== 0) {
    throw new Error('Exact purge namespace release left unexpected entries.');
  }
  progress(releasedEntries, true);
}

async function main() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const envelopeLine = await iterator.next();
  if (envelopeLine.done) throw new Error('Exact purge durable manifest input is absent.');
  const envelope = JSON.parse(envelopeLine.value);
  const expectedManifest = Array.isArray(envelope.entries) ? envelope.entries : [];
  const expectedDevice = Number(process.env.O8_PURGE_EXPECTED_DEVICE);
  const expectedInode = Number(process.env.O8_PURGE_EXPECTED_INODE);
  const captured = await fsp.lstat('.');
  if (!captured.isDirectory() || captured.isSymbolicLink()
    || captured.dev !== expectedDevice || captured.ino !== expectedInode) {
    throw new Error('Exact purge captured an unexpected directory identity.');
  }
  rootCanonical = fs.realpathSync('.');
  const rootHandle = await fsp.open('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  directories.push({ relative: '.', entry: { device: captured.dev, inode: captured.ino, kind: 'directory' }, handle: rootHandle });
  beginPhase('capture');
  const capturedManifest = await manifestAt();
  const owned = new Set(expectedManifest.map(entry => entry.relative));
  const manifest = process.env.O8_PURGE_PRESERVE_UNLISTED === '1'
    ? capturedManifest.filter(entry => owned.has(entry.relative)) : capturedManifest;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const expectedFingerprint = process.env.O8_PURGE_EXPECTED_FINGERPRINT || '';
  if (expectedManifest.length > 0) {
    verifyMonotonicManifest(manifest, expectedManifest);
  } else if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    if (manifest.length !== 1 || manifest[0].relative !== '.' || (await fsp.readdir('.')).length !== 0) {
      throw new Error('Exact purge tree fingerprint changed before capture.');
    }
  }
  process.stdout.write('O8_PURGE_CAPTURED ' + fingerprint + '\n');
  if (process.env.O8_PURGE_CAPTURE_ONLY === '1') {
    process.stdout.write('O8_PURGE_MANIFEST ' + Buffer.from(JSON.stringify(manifest)).toString('base64url') + '\n');
    return;
  }
  const continuation = await iterator.next();
  if (continuation.done) throw new Error('Exact purge continuation was not authorized.');
  await releaseContent(manifest);
}
void main().catch((error) => {
  console.error('[exact-directory-purge]', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

async function runCapturedPurge(
  candidatePath: string,
  identity: { device: number; inode: number },
  expectedFingerprint: string | undefined,
  expectedManifest: ExactDirectoryManifestEntry[] | undefined,
  afterTreeCapture: AfterTreeCapture | undefined,
  namespace: PurgeNamespace,
  preserveUnlisted = false,
): Promise<void> {
  const child = spawn(process.execPath, ['-e', PURGE_CAPTURE_SCRIPT], {
    cwd: namespace.canonicalPath,
    env: childEnvironment({ env: { O8_PURGE_PRESERVE_UNLISTED: preserveUnlisted ? '1' : '0', O8_PURGE_EXPECTED_DEVICE: String(identity.device), O8_PURGE_EXPECTED_INODE: String(identity.inode), ...(expectedFingerprint ? { O8_PURGE_EXPECTED_FINGERPRINT: expectedFingerprint } : {}) } }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let witness: CapturedPurgeProcessWitness | undefined;
  const closed = new Promise<number | null>((resolve) => child.once('close', code => {
    if (witness && child.pid) {
      settleCloseObservedHelper(child.pid);
      capturedPurgeProcesses.delete(witness);
    }
    resolve(code);
  }));
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.on('error', () => { /* Native close outcome remains authoritative. */ });
  child.stdin.write(`${JSON.stringify({ entries: expectedManifest ?? [] })}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      let completed = -1;
      let inspected = 0;
      let timeout: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          // Capture has no mutation authority. Stop and observe our own helper
          // rather than waiting indefinitely for EOF behind a stalled scan.
          child.kill('SIGKILL');
          reject(new Error(`Exact purge capture stalled after ${Date.now() - started}ms (${Math.max(0, completed)} entries; no progress for 60000ms).`));
        }, 60_000);
      };
      arm();
      const inspect = () => {
        let newline: number;
        while ((newline = stdout.indexOf('\n', inspected)) >= 0) {
          const line = stdout.slice(inspected, newline);
          inspected = newline + 1;
          if (!line.startsWith('O8_PURGE_PROGRESS ')) continue;
          const progress = JSON.parse(line.slice('O8_PURGE_PROGRESS '.length)) as { phase: string; entries: number };
          if (progress.phase === 'capture' && progress.entries > completed) {
            completed = progress.entries;
            arm();
          }
        }
        if (/O8_PURGE_CAPTURED [0-9a-f]{64}\n/.test(stdout)) {
          clearTimeout(timeout);
          child.stdout.off('data', inspect);
          resolve();
        }
      };
      child.stdout.on('data', inspect);
      void closed.then(() => {
        if (!/O8_PURGE_CAPTURED [0-9a-f]{64}\n/.test(stdout)) {
          clearTimeout(timeout);
          child.stdout.off('data', inspect);
          reject(new Error(stderr.trim() || 'Exact purge capture failed.'));
        }
      });
    });
    await assertPurgeNamespace(namespace, identity);
    const stat = await lstat(namespace.canonicalPath);
    const probe = child.pid ? await probeMetadataLockProcessIdentity(child.pid) : null;
    if (!probe || probe.state !== 'live' || !child.pid || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.device || stat.ino !== identity.inode
      || await realpath(namespace.canonicalPath) !== namespace.canonicalPath) {
      throw new Error('Exact purge could not attest its paused native process and namespace.');
    }
    witness = Object.freeze({ [capturedPurgeBrand]: true as const });
    capturedPurgeProcesses.set(witness, { pid: child.pid, identity: probe.identity,
      candidatePath: namespace.canonicalPath, device: identity.device, inode: identity.inode, namespace });
    await afterTreeCapture?.(candidatePath, witness);
    await assertPurgeNamespace(namespace, identity);
  } catch (error) {
    // EOF refuses release. Settle the captured child before reporting refusal,
    // so the caller cannot race an authorized writer after seeing an error.
    child.stdin.end();
    await closed;
    throw error;
  }
  child.stdin.end('continue\n');
  const code = await closed;
  reportPurgePhases(stdout);
  if (code !== 0) throw new Error(stderr.trim() || 'Exact purge content release failed.');
}

function reportPurgePhases(stdout: string): void {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('O8_PURGE_PROGRESS ')) continue;
    const progress = JSON.parse(line.slice('O8_PURGE_PROGRESS '.length)) as { done?: boolean };
    if (progress.done) console.info('[exact-directory-purge]', line.slice('O8_PURGE_PROGRESS '.length));
  }
}

/** Capture the exact descendant inode set before content verification begins. */
export async function captureExactDirectoryManifestFingerprint(
  candidatePath: string,
  identity: { device: number; inode: number },
): Promise<string> {
  return (await captureExactDirectoryManifest(candidatePath, identity)).fingerprint;
}

/** Capture the exact descendant inode set used for crash-safe monotonic release. */
export async function captureExactDirectoryManifest(
  candidatePath: string,
  identity: { device: number; inode: number },
  options: { contents?: boolean } = {},
): Promise<ExactDirectoryManifest> {
  const child = spawn(process.execPath, ['-e', PURGE_CAPTURE_SCRIPT], {
    cwd: candidatePath,
    env: childEnvironment({ env: { O8_PURGE_EXPECTED_DEVICE: String(identity.device), O8_PURGE_EXPECTED_INODE: String(identity.inode), O8_PURGE_CAPTURE_ONLY: '1', ...(options.contents ? { O8_PURGE_CAPTURE_CONTENTS: '1' } : {}) } }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end('{"entries":[]}\n');
  const deadline = options.contents ? setTimeout(() => child.kill('SIGKILL'), 60_000) : undefined;
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  clearTimeout(deadline);
  reportPurgePhases(stdout);
  const match = /O8_PURGE_CAPTURED ([0-9a-f]{64})\n/.exec(stdout);
  const manifestMatch = /O8_PURGE_MANIFEST ([A-Za-z0-9_-]+)\n/.exec(stdout);
  if (code !== 0 || !match?.[1] || !manifestMatch?.[1]) {
    throw new Error(stderr.trim() || 'Exact purge tree fingerprint capture failed.');
  }
  const entries = JSON.parse(Buffer.from(manifestMatch[1], 'base64url').toString('utf8')) as unknown;
  if (!Array.isArray(entries)) throw new Error('Exact purge tree manifest capture is invalid.');
  return { fingerprint: match[1], entries: entries as ExactDirectoryManifestEntry[] };
}

/** Release only a prior compiler inventory, retaining the registered output root. */
export async function clearExactDirectoryContents(
  candidatePath: string,
  identity: { device: number; inode: number },
  manifest: ExactDirectoryManifest,
  beforeCapture: (candidatePath: string) => Promise<void>,
  afterTreeCapture: AfterTreeCapture,
): Promise<void> {
  if (!manifest.entries.length) throw new Error('Compiler replacement requires its prior ownership inventory.');
  const namespace = await capturePurgeNamespace(candidatePath, identity);
  await beforeCapture(candidatePath);
  await assertPurgeNamespace(namespace, identity);
  await runCapturedPurge(candidatePath, identity, manifest.fingerprint, manifest.entries,
    afterTreeCapture, namespace, true);
  await assertPurgeNamespace(namespace, identity);
}

/** Release receipted file bytes and namespace entries through captured cwd boundaries. */
export async function purgeExactDirectory(
  candidatePath: string,
  identity: { device: number; inode: number },
  beforeCapture?: (candidatePath: string) => Promise<void>,
  afterTreeCapture?: AfterTreeCapture,
  afterContentRelease?: (candidatePath: string) => Promise<void>,
  expectedFingerprint?: string,
  expectedManifest?: ExactDirectoryManifestEntry[],
  preserveUnlisted = false,
): Promise<void> {
  const namespace = await capturePurgeNamespace(candidatePath, identity);
  await beforeCapture?.(candidatePath);
  await assertPurgeNamespace(namespace, identity);
  await runCapturedPurge(
    candidatePath,
    identity,
    expectedFingerprint,
    expectedManifest,
    afterTreeCapture,
    namespace,
    preserveUnlisted,
  );
  if (preserveUnlisted && (await readdir(namespace.canonicalPath)).length > 0) return;
  await afterContentRelease?.(candidatePath);
  await assertPurgeNamespace(namespace, identity);
  // The caller already journals this exact namespace. Keep it replayable until
  // final removal and never infer authority over similarly named siblings.
  await removeExactEmptyChildDirectory(
    namespace.parentIdentity.canonicalPath, namespace.parentIdentity, namespace.canonicalPath, identity,
  );
}
