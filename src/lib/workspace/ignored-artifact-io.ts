import { resolveGitBinary } from '@/lib/git/binary';
import { spawn, type ChildProcessWithoutNullStreams } from '@/lib/providers/child-process';
import { AsyncLocalStorage } from 'node:async_hooks';

import { ARTIFACT_PROTOCOL_SCRIPT } from '@/lib/workspace/ignored-artifact-protocol';
import { artifactNodeScript } from '@/lib/workspace/ignored-artifact-worker';

import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

export interface IgnoredArtifactEntry {
  path: string;
  kind: 'file' | 'directory';
  mode: number;
  device: number;
  inode: number;
  bytes: number;
  sha256: string | null;
  content: string | null;
}

export interface ArtifactRevision {
  headCommit: string;
  treeSha: string;
}

export interface IgnoredArtifactCapture extends ArtifactRevision {
  entries: IgnoredArtifactEntry[];
  bytes: number;
}

export interface ArtifactRestoreFileReceipt {
  path: string;
  device: number;
  inode: number;
  phase: 'prepared' | 'complete';
}

export interface ArtifactRestoreEvent extends ArtifactRestoreFileReceipt {
  sha256: string;
  bytes: number;
}

// Work happens in an OS-pinned cwd. Parents are opened without following links,
// and each file is read/written through its own verified descriptor.
const ARTIFACT_IO_SCRIPT = ARTIFACT_PROTOCOL_SCRIPT + String.raw`
const { execFileSync } = require('node:child_process');
let mode = process.argv[1];
const persistent = mode === 'close-reader';
const restingCwd = process.cwd();
const restingPwd = process.env.PWD;
const workerScript = process.argv[2];
let rootFd;
let rootIdentity;
function verifyRoot() {
  const actual = fs.lstatSync('.');
  const pinned = fs.fstatSync(rootFd);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== rootIdentity.device
    || actual.ino !== rootIdentity.inode || pinned.dev !== actual.dev || pinned.ino !== actual.ino
    || fs.realpathSync('.') !== rootIdentity.canonicalPath) throw new Error('Artifact workspace ownership changed.');
}
function git(args) {
  verifyRoot();
  const env = { ...o8AmbientEnvironment(), GIT_OPTIONAL_LOCKS: '0', GIT_WORK_TREE: '.' };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return withO8ChildPolicy(freshEnv => execFileSync(process.argv[3], args, { encoding: 'utf8', env: freshEnv, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }), { env });
}
function readRevision() {
  try {
    const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const treeSha = git(['rev-parse', '--verify', 'HEAD^{tree}']).trim();
    if (git(['ls-files', '-v', '-z']).split('\0').some((line) => /^[a-zS] /.test(line))) {
      throw new Error('Artifact capture refuses hidden index flags.');
    }
    if (git(['ls-files', '--stage', '-z']).split('\0').some((line) => line.startsWith('160000 '))) {
      throw new Error('Artifact capture requires separate submodule preservation.');
    }
    return { headCommit, treeSha };
  } catch {
    // Failed source inspection, including hidden index flags, must retain its
    // source-revision refusal instead of becoming an ignored-content failure.
    throw Object.assign(new Error('Artifact source revision is uncertain.'), { code: 'unbanked_source' });
  }
}
function verifyGit(input) {
  const truth = readRevision();
  if (truth.headCommit !== input.headCommit || truth.treeSha !== input.treeSha) {
    throw Object.assign(new Error('Artifact workspace revision changed.'), { code: 'unbanked_source' });
  }
  return truth;
}
function inspectRestoreRevision() {
  const truth = readRevision();
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination has unbanked source changes.');
  }
  return truth;
}
async function receipt(event) {
  process.stdout.write('O8_ARTIFACT_EVENT ' + Buffer.from(JSON.stringify(event)).toString('base64url') + '\n');
  if (await nextLine() !== 'ok') throw new Error('Artifact ownership receipt was not persisted.');
}
async function capture(input) {
  const truth = verifyGit(input);
  const ignored = [];
  for (const record of git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']).split('\0')) {
    if (!record) continue;
    if (!record.startsWith('!! ')) {
      if (input.discardSource === true && !input.requireCleanSource) continue;
      throw Object.assign(new Error('Source changes were not banked before artifact capture.'), { code: 'unbanked_source' });
    }
    ignored.push(safeRelative(record.slice(3).replace(/\/$/, '')));
  }
  const excluded = input.rebuildablePaths.map(safeRelative);
  const copied = input.copiedEnvironment;
  const references = input.environmentReferences || {};
  const entries = [];
  const seen = new Set();
  const started = Date.now();
  let bytes = 0;
  let client;
  try {
    async function visit(relative) {
      if (seen.has(relative) || excluded.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'))) return;
      seen.add(relative);
      if (seen.size > 20000 || Date.now() - started > 10000) throw new Error('Artifact capture scan bound was exceeded.');
      verifyRoot();
      const copiedBound = Object.prototype.hasOwnProperty.call(copied, relative);
      client ??= await connectArtifactNode(workerScript, '.', rootIdentity, rootIdentity.canonicalPath,
        started + 10000, async () => { throw new Error('Capture cannot publish restore receipts.'); });
      const captured = await client.request({ action: 'capture', path: relative, originalPath: relative,
        referenceTarget: Object.prototype.hasOwnProperty.call(references, relative) ? references[relative] : null,
        copiedBound, copiedHash: copiedBound ? copied[relative] : null, remainingBytes: 32 * 1024 * 1024 - bytes });
      if (captured.entry) entries.push(captured.entry);
      if (captured.stat.kind === 'directory') {
        for (const name of captured.names) await visit(safeRelative(relative + '/' + name));
        await client.request({ action: 'verify-directory', path: relative, stat: captured.stat, names: captured.names });
      } else if (captured.entry) bytes += captured.entry.bytes;
    }
    for (const relative of [...new Set(ignored)].sort()) await visit(relative);
  } finally { await client?.close(); }
  verifyGit(input);
  return { ...truth, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), bytes };
}
async function restore(input) {
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination has unbanked source changes.');
  }
  const owned = new Map(input.ownedFiles.map((entry) => [entry.path, entry]));
  const seen = new Set();
  let totalBytes = 0;
  if (input.entries.length > 20000) throw new Error('Artifact restore entry bound was exceeded.');
  const client = await connectArtifactNode(workerScript, '.', rootIdentity, rootIdentity.canonicalPath,
    Date.now() + 29000, receipt);
  try {
    for (const entry of input.entries) {
      safeRelative(entry.path);
      if (seen.has(entry.path) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Artifact manifest is invalid.');
      seen.add(entry.path);
      if (entry.kind !== 'file' && entry.kind !== 'directory') throw new Error('Artifact kind is unsupported.');
      if (entry.kind === 'file') {
        const content = Buffer.from(entry.content, 'base64');
        totalBytes += content.length;
        if (content.length !== entry.bytes || content.toString('base64') !== entry.content || hash(content) !== entry.sha256
          || content.length > 16 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('Artifact content receipt is invalid.');
        git(['check-ignore', '--quiet', '--', entry.path]);
      }
      const prior = await client.request({ action: 'inspect', path: entry.path });
      if (!prior) {
        if (owned.has(entry.path)) throw new Error('A previously owned artifact restore file disappeared.');
        continue;
      }
      if (entry.kind === 'directory') {
        if (prior.kind !== 'directory') throw new Error('Artifact directory destination is occupied.');
        continue;
      }
      const owner = owned.get(entry.path);
      if (!owner || prior.kind !== 'file' || prior.dev !== owner.device || prior.ino !== owner.inode || prior.nlink !== 1) {
        throw new Error('Artifact restore refuses to overwrite an unowned destination.');
      }
    }
    for (const entry of input.entries.filter((entry) => entry.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      verifyRoot();
      await client.request({ action: 'create-directory', path: entry.path });
    }
    for (const entry of input.entries.filter((entry) => entry.kind === 'file')) {
      verifyRoot();
      await client.request({ action: 'restore-file', path: entry.path, originalPath: entry.path,
        entry, owner: owned.get(entry.path) || null });
    }
  } finally { await client.close(); }
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination changed source during publication.');
  }
  return { restoredFiles: input.entries.filter((entry) => entry.kind === 'file').length, bytes: totalBytes };
}
(async () => {
  while (true) {
    let line;
    try { line = await nextLine(); } catch (error) { if (persistent && inputEnded) break; throw error; }
    const envelope = JSON.parse(line);
    if (persistent) {
      if (!['capture', 'revision'].includes(envelope.mode)) throw new Error('Close helper refuses a writing operation.');
      mode = envelope.mode;
      process.chdir(envelope.workspacePath);
    }
    rootFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let result;
    try {
      rootIdentity = envelope.identity;
      verifyRoot();
      process.env.PWD = rootIdentity.canonicalPath;
      const input = envelope.request;
      result = mode === 'revision' ? inspectRestoreRevision()
        : mode === 'capture' ? await capture(input) : mode === 'restore' ? await restore(input)
        : (() => { throw new Error('Artifact operation mode is invalid.'); })();
    } finally {
      fs.closeSync(rootFd);
      if (persistent) {
        process.chdir(restingCwd);
        if (restingPwd === undefined) delete process.env.PWD; else process.env.PWD = restingPwd;
      }
    }
    // The helper is outside the workspace and every read descriptor/child has
    // settled before the parent may proceed to a native process proof.
    process.stdout.write('O8_ARTIFACT_RESULT ' + Buffer.from(JSON.stringify(result)).toString('base64url') + '\n');
    if (!persistent) break;
  }
  process.exit(0);
})().catch((error) => {
  process.stderr.write(error.code === 'unbanked_source' ? 'O8_ARTIFACT_UNBANKED_SOURCE\n'
    : 'Pinned artifact operation refused; preservation and retention authority remain intact.\n');
  process.exit(78);
});
`;

async function runArtifactIoNative<T>(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  mode: 'capture' | 'restore' | 'revision';
  request: unknown;
  onReceipt?: (event: ArtifactRestoreEvent) => void;
}): Promise<T> {
  const invocation = guardedWorkspaceInvocation(
    process.execPath, ['-e', ARTIFACT_IO_SCRIPT, input.mode, artifactNodeScript(), resolveGitBinary()], input.identity,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.workspacePath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let outputBytes = 0;
    let result: T | undefined;
    let failure: Error | null = null;
    let sourceChanges = false;
    const timeout = setTimeout(() => {
      failure = new Error('Pinned artifact operation exceeded its time bound.');
      child.kill();
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 64 * 1024 * 1024) {
        failure = new Error('Pinned artifact output exceeded its byte bound.');
        child.kill();
        return;
      }
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          if (line.startsWith('O8_ARTIFACT_EVENT ')) {
            if (!input.onReceipt) throw new Error('Artifact ownership receipt handler is absent.');
            const event = JSON.parse(Buffer.from(line.slice(18), 'base64url').toString('utf8')) as ArtifactRestoreEvent;
            input.onReceipt(event);
            child.stdin.write('ok\n');
          } else if (line.startsWith('O8_ARTIFACT_RESULT ')) {
            result = JSON.parse(Buffer.from(line.slice(19), 'base64url').toString('utf8')) as T;
          } else {
            throw new Error('Artifact worker returned an unrecognized receipt.');
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Artifact receipt persistence failed.');
          child.stdin.destroy();
          child.kill();
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (chunk.includes('O8_ARTIFACT_UNBANKED_SOURCE')) sourceChanges = true; });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (failure || code !== 0 || result === undefined) {
        reject(failure ?? (sourceChanges ? new UnbankedArtifactSourceError() : new Error('Pinned artifact operation refused; source evidence remains held.')));
      } else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ request: input.request, identity: input.identity }) + '\n');
  });
}

export function captureIgnoredArtifacts(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  headCommit: string;
  treeSha: string;
  rebuildablePaths: string[];
  copiedEnvironment: Record<string, string | null>;
  environmentReferences?: Record<string, string>;
  discardSource?: boolean;
  requireCleanSource?: true;
}): Promise<IgnoredArtifactCapture> {
  return runArtifactIo({ ...input, mode: 'capture', request: input });
}

export function restoreIgnoredArtifacts(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  capture: IgnoredArtifactCapture;
  destinationRevision: ArtifactRevision;
  ownedFiles: ArtifactRestoreFileReceipt[];
  onReceipt: (event: ArtifactRestoreEvent) => void;
}): Promise<{ restoredFiles: number; bytes: number }> {
  return runArtifactIo({
    ...input, mode: 'restore',
    request: { ...input.capture, ...input.destinationRevision, ownedFiles: input.ownedFiles },
  });
}

export function inspectArtifactRestoreRevision(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
}): Promise<ArtifactRevision> {
  return runArtifactIo({ ...input, mode: 'revision', request: {} });
}

interface CloseArtifactReader {
  active: boolean;
  poisoned: boolean;
  starts: number;
  child?: ChildProcessWithoutNullStreams;
  closed?: Promise<number | null>;
  tail: Promise<unknown>;
}
const closeReader = new AsyncLocalStorage<CloseArtifactReader>();

/** Read-only helper lifetime belongs to the close, including refused closes. */
export async function withCloseArtifactReader<T>(operation: () => Promise<T>): Promise<T> {
  const reader: CloseArtifactReader = { active: true, poisoned: false, starts: 0, tail: Promise.resolve() };
  try { return await closeReader.run(reader, operation); }
  finally {
    reader.active = false;
    await reader.tail.catch(() => {});
    if (reader.child) {
      reader.child.stdin.end();
      const timer = setTimeout(() => reader.child?.kill('SIGKILL'), 2_000);
      try { await reader.closed; } finally { clearTimeout(timer); }
    }
  }
}

function runArtifactIo<T>(input: Parameters<typeof runArtifactIoNative>[0]): Promise<T> {
  const reader = closeReader.getStore();
  if (!reader?.active || input.mode === 'restore') return runArtifactIoNative<T>(input);
  const operation = reader.tail.then(() => {
    if (!reader.active || reader.poisoned) throw new Error('Close artifact reader authority expired or was refused.');
    if (!reader.child) {
      reader.starts += 1;
      reader.child = spawn(process.execPath, ['-e', ARTIFACT_IO_SCRIPT, 'close-reader', artifactNodeScript(), resolveGitBinary()], {
        cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      reader.closed = new Promise(resolve => reader.child!.once('close', code => resolve(code)));
      reader.child.stderr.resume();
      reader.child.stdin.on('error', () => {});
    }
    const child = reader.child;
    return new Promise<T>((resolve, reject) => {
      let output = '';
      let bytes = 0;
      let sourceChanges = false;
      const stderr = (chunk: Buffer) => { if (chunk.toString().includes('O8_ARTIFACT_UNBANKED_SOURCE')) sourceChanges = true; };
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Pinned artifact operation exceeded its time bound.')); }, 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', data);
        child.stderr.off('data', stderr);
        child.off('close', closed);
        child.off('error', fail);
      };
      const fail = (error: Error) => {
        cleanup();
        reader.poisoned = true;
        child.kill('SIGKILL');
        // A stop request is not settlement. No native proof can resume until
        // the exact reader process has actually closed.
        void reader.closed!.then(() => reject(error));
      };
      const closed = () => fail(sourceChanges ? new UnbankedArtifactSourceError() : new Error('Pinned artifact operation refused; source evidence remains held.'));
      const data = (chunk: Buffer) => {
        bytes += chunk.length;
        output += chunk.toString();
        if (bytes > 64 * 1024 * 1024) { child.kill('SIGKILL'); fail(new Error('Pinned artifact output exceeded its byte bound.')); return; }
        if (!output.endsWith('\n')) return;
        try {
          if (!output.startsWith('O8_ARTIFACT_RESULT ') || output.trimEnd().includes('\n')) {
            throw new Error('Artifact worker returned an unrecognized receipt.');
          }
          const result = JSON.parse(Buffer.from(output.slice(19).trim(), 'base64url').toString('utf8')) as T;
          cleanup();
          resolve(result);
        } catch (error) { child.kill('SIGKILL'); fail(error instanceof Error ? error : new Error('Invalid artifact result.')); }
      };
      child.stdout.on('data', data);
      child.stderr.on('data', stderr);
      child.once('close', closed);
      child.once('error', fail);
      if (child.exitCode !== null || child.signalCode !== null) { closed(); return; }
      child.stdin.write(JSON.stringify({ mode: input.mode, workspacePath: input.workspacePath,
        identity: input.identity, request: input.request }) + '\n');
    });
  });
  reader.tail = operation.catch(() => {});
  return operation;
}

export class UnbankedArtifactSourceError extends Error {
  constructor() { super('Source changes were not banked before artifact capture.'); }
}

export function closeArtifactReaderDiagnostics(): { starts: number; pid: number | null } | null {
  const reader = closeReader.getStore();
  return reader?.active ? { starts: reader.starts, pid: reader.child?.pid ?? null } : null;
}
