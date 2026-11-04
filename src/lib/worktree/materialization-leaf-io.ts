import { childEnvironment } from '@/lib/providers/spawn-environment';
import { spawn } from '@/lib/providers/child-process';
import path from 'node:path';

import { guardedWorkspaceScriptInvocation } from './materialization-execution';
import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { resolveStorageVolumeId } from './storage-telemetry';
import { chargeWorktreeMetadataRead, worktreeMetadataReadLimit } from './maintenance-budget';
import { APFS_DIRECTORY_CLONE_SCRIPT } from './apfs-directory-clone';
import { PINNED_WORKSPACE_PATH_SCRIPT, PINNED_WORKSPACE_READ_SCRIPT } from './materialization-read-script';
import { tryPinnedWorkspaceRead } from './materialization-read-session';

export interface PinnedWorkspaceFileIdentity {
  device: number;
  inode: number;
  canonicalPath?: string;
  volumeId?: string;
}

export class PinnedWorkspacePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedWorkspacePublishError';
  }
}

export function isPinnedWorkspacePublishError(error: unknown): boolean {
  return error instanceof PinnedWorkspacePublishError;
}

const PINNED_LEAF_IO_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
${APFS_DIRECTORY_CLONE_SCRIPT}

${PINNED_WORKSPACE_PATH_SCRIPT}
${PINNED_WORKSPACE_READ_SCRIPT}
async function copyFileExact(sourcePath, targetPath) {
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let target;
  try {
    const before = fs.fstatSync(source);
    if (!before.isFile()) throw new Error('Pinned workspace source is not a regular file.');
    const content = readExactHandle(source, before.size);
    await waitForStep('copy-file-read');
    const repeated = readExactHandle(source, before.size);
    const after = fs.fstatSync(source);
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (after.mode & 0o777) !== (before.mode & 0o777)
      || !content.equals(repeated)) {
      throw new Error('Pinned workspace source file changed during copy.');
    }
    target = fs.openSync(
      targetPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      before.mode & 0o777,
    );
    const targetIdentity = fs.fstatSync(target);
    await waitForStep('copy-file-opened');
    const namedTarget = fs.lstatSync(targetPath);
    if (targetIdentity.nlink !== 1
      || !namedTarget.isFile() || namedTarget.isSymbolicLink()
      || namedTarget.dev !== targetIdentity.dev || namedTarget.ino !== targetIdentity.ino) {
      throw new Error('Pinned workspace copied target is not exclusively linked.');
    }
    fs.writeFileSync(target, content);
    fs.fsyncSync(target);
    const published = fs.fstatSync(target);
    const publishedName = fs.lstatSync(targetPath);
    if (published.nlink !== 1 || published.size !== content.length
      || (published.mode & 0o777) !== (before.mode & 0o777)
      || !readExactHandle(target, published.size).equals(content)
      || !publishedName.isFile() || publishedName.isSymbolicLink()
      || publishedName.dev !== published.dev || publishedName.ino !== published.ino) {
      throw new Error('Pinned workspace target did not match its source receipt.');
    }
  } finally {
    if (target !== undefined) fs.closeSync(target);
    fs.closeSync(source);
  }
}

async function copyTree(sourcePath, targetPath) {
  const source = fs.lstatSync(sourcePath);
  if (source.isSymbolicLink()) throw new Error('Pinned hydration refuses source symlinks.');
  await waitForStep('source');
  let reproved;
  try {
    reproved = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Pinned hydration source changed after capture.');
    throw error;
  }
  if (reproved.isSymbolicLink() || reproved.dev !== source.dev || reproved.ino !== source.ino) {
    throw new Error('Pinned hydration source changed after capture.');
  }
  if (source.isFile()) {
    const handle = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const captured = fs.fstatSync(handle);
      if (!captured.isFile() || captured.dev !== source.dev || captured.ino !== source.ino) {
        throw new Error('Pinned hydration source file changed before capture.');
      }
      const target = fs.openSync(
        targetPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        source.mode & 0o777,
      );
      try {
        if (fs.fstatSync(target).nlink !== 1) {
          throw new Error('Pinned hydration target file is not exclusively linked.');
        }
        fs.writeFileSync(target, fs.readFileSync(handle));
        fs.fsyncSync(target);
        if (fs.fstatSync(target).nlink !== 1) {
          throw new Error('Pinned hydration target file gained another link during copy.');
        }
      } finally {
        fs.closeSync(target);
      }
      const after = fs.fstatSync(handle);
      if (after.dev !== captured.dev || after.ino !== captured.ino
        || after.size !== captured.size || after.mtimeMs !== captured.mtimeMs) {
        throw new Error('Pinned hydration source file changed during copy.');
      }
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  if (!source.isDirectory()) throw new Error('Pinned hydration source has an unsupported entry.');
  fs.mkdirSync(targetPath, source.mode & 0o777);
  const names = fs.readdirSync(sourcePath).sort();
  for (const name of names) {
    await copyTree(path.join(sourcePath, name), path.join(targetPath, name));
  }
  const after = fs.lstatSync(sourcePath);
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== source.dev || after.ino !== source.ino
    || JSON.stringify(fs.readdirSync(sourcePath).sort()) !== JSON.stringify(names)) {
    throw new Error('Pinned hydration source directory changed during copy.');
  }
}

function fingerprintTree(candidatePath, relative = '.') {
  const hash = crypto.createHash('sha256');
  const visit = (entryPath, entryRelative) => {
    const entry = fs.lstatSync(entryPath);
    if (entry.isSymbolicLink()) throw new Error('Pinned hydration refuses source symlinks.');
    if (entry.isFile()) {
      const handle = fs.openSync(entryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const captured = fs.fstatSync(handle);
        if (!captured.isFile() || captured.dev !== entry.dev || captured.ino !== entry.ino) {
          throw new Error('Pinned hydration source file changed during fingerprint.');
        }
        hash.update('file\0' + entryRelative + '\0' + (entry.mode & 0o777).toString(8) + '\0');
        hash.update(fs.readFileSync(handle));
        const after = fs.fstatSync(handle);
        if (after.dev !== captured.dev || after.ino !== captured.ino
          || after.size !== captured.size || after.mtimeMs !== captured.mtimeMs) {
          throw new Error('Pinned hydration source file changed during fingerprint.');
        }
      } finally {
        fs.closeSync(handle);
      }
      return;
    }
    if (!entry.isDirectory()) throw new Error('Pinned hydration source has an unsupported entry.');
    const names = fs.readdirSync(entryPath).sort();
    hash.update('directory\0' + entryRelative + '\0'
      + (entry.mode & 0o777).toString(8) + '\0' + JSON.stringify(names) + '\0');
    for (const name of names) {
      visit(path.join(entryPath, name), entryRelative === '.' ? name : path.join(entryRelative, name));
    }
    const after = fs.lstatSync(entryPath);
    if (!after.isDirectory() || after.isSymbolicLink()
      || after.dev !== entry.dev || after.ino !== entry.ino
      || JSON.stringify(fs.readdirSync(entryPath).sort()) !== JSON.stringify(names)) {
      throw new Error('Pinned hydration source directory changed during fingerprint.');
    }
  };
  visit(candidatePath, relative);
  return hash.digest('hex');
}

async function main() {
  const operation = process.argv[1];
  const relative = process.argv[2];
  if (operation === 'read' || operation === 'inspect-entry') {
    const receipt = await readPinnedEntry(operation, relative, process.argv[3]);
    process.stdout.write(receipt.stdout);
    process.exitCode = receipt.code;
    return;
  }
  const prepared = await prepareParent(relative);
  if (operation === 'atomic-write') {
    const injectedContent = process.env.O8_PINNED_ATOMIC_CONTENT;
    const content = injectedContent === undefined
      ? Buffer.concat(await Array.fromAsync(process.stdin))
      : Buffer.from(injectedContent, 'base64');
    let handle;
    const expectedTarget = process.env.O8_PINNED_EXPECTED_TARGET;
    if (expectedTarget === 'null') {
      handle = fs.openSync(
        prepared.target,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
    } else {
      try {
        handle = fs.openSync(prepared.target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if (error.code !== 'ENOENT' || expectedTarget !== undefined) throw error;
        handle = fs.openSync(
          prepared.target,
          fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
      }
    }
    const receipt = fs.fstatSync(handle);
    if (!receipt.isFile() || receipt.nlink !== 1) {
      fs.closeSync(handle);
      throw new Error('Pinned workspace direct-write target is not exclusively linked.');
    }
    if (expectedTarget && expectedTarget !== 'null') {
      const expected = JSON.parse(expectedTarget);
      if (receipt.dev !== expected.device || receipt.ino !== expected.inode) {
        fs.closeSync(handle);
        throw new Error('Pinned workspace direct-write target does not match its durable receipt.');
      }
    }
    await waitForStep('atomic-opened');
    try {
      const named = fs.lstatSync(prepared.target);
      if (!named.isFile() || named.isSymbolicLink()
        || named.nlink !== 1
        || named.dev !== receipt.dev || named.ino !== receipt.ino
        || fs.fstatSync(handle).nlink !== 1) {
        throw new Error('Pinned workspace target changed before direct write.');
      }
      fs.ftruncateSync(handle, 0);
      fs.writeSync(handle, content, 0, content.length, 0);
      fs.fsyncSync(handle);
      const current = fs.fstatSync(handle);
      const persisted = fs.readFileSync(handle);
      const published = fs.lstatSync(prepared.target);
      if (!current.isFile() || current.nlink !== 1
        || current.dev !== receipt.dev || current.ino !== receipt.ino
        || current.size !== content.length
        || crypto.createHash('sha256').update(persisted).digest('hex')
          !== crypto.createHash('sha256').update(content).digest('hex')
        || !published.isFile() || published.isSymbolicLink()
        || published.dev !== receipt.dev || published.ino !== receipt.ino) {
        throw new Error('Pinned workspace direct write lost its exact target.');
      }
      process.stdout.write(JSON.stringify({
        device: receipt.dev,
        inode: receipt.ino,
        canonicalPath: fs.realpathSync(prepared.target),
      }));
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  if (operation === 'create-install-runtime') {
    // prepareParent captured every ancestor. The UUID leaf must be new; never
    // adopt an existing directory or populate through an unchecked namespace.
    const expectedPath = path.join(fs.realpathSync('.'), prepared.target);
    fs.mkdirSync(prepared.target, { mode: 0o700 });
    const before = fs.lstatSync(prepared.target);
    await waitForStep('install-runtime-created');
    process.chdir(prepared.target);
    const captured = fs.lstatSync('.');
    const canonicalPath = fs.realpathSync('.');
    if (!captured.isDirectory() || captured.isSymbolicLink()
      || captured.dev !== before.dev || captured.ino !== before.ino
      || canonicalPath !== expectedPath) {
      throw new Error('Pinned install runtime changed during capture.');
    }
    // Git sees the runtime as ignored rebuildable output before any file exists
    // in it, so an install killed before its own retirement leaves no source
    // change for workspace cleanup, park or retirement capture to retain.
    const ignore = Buffer.from('*\n');
    const ignoreFd = fs.openSync('.gitignore', fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(ignoreFd, ignore, 0, ignore.length, 0);
      fs.fsyncSync(ignoreFd);
      const written = fs.fstatSync(ignoreFd);
      const named = fs.lstatSync('.gitignore');
      if (!written.isFile() || written.nlink !== 1 || written.size !== ignore.length
        || !named.isFile() || named.isSymbolicLink() || named.dev !== written.dev || named.ino !== written.ino) {
        throw new Error('Pinned install runtime ignore file changed during creation.');
      }
    } finally { fs.closeSync(ignoreFd); }
    // The captured cwd keeps all child creation in this private inode even if
    // the workspace namespace is renamed while the operation is in flight.
    for (const name of ['home', 'config', 'xdg-cache', 'tmp', 'corepack']) {
      fs.mkdirSync(name, { mode: 0o700 });
    }
    const config = fs.lstatSync('config');
    if (!config.isDirectory() || config.isSymbolicLink()) throw new Error('Pinned install config is unsafe.');
    await waitForStep('install-runtime-config');
    process.chdir('config');
    const configCwd = fs.lstatSync('.');
    if (configCwd.dev !== config.dev || configCwd.ino !== config.ino
      || fs.realpathSync('.') !== path.join(canonicalPath, 'config')) {
      throw new Error('Pinned install config changed during capture.');
    }
    for (const name of ['user.rc', 'global.rc']) {
      const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const opened = fs.fstatSync(fd);
        await waitForStep('install-runtime-file-opened');
        fs.fsyncSync(fd);
        const after = fs.fstatSync(fd);
        const named = fs.lstatSync(name);
        if (!opened.isFile() || opened.nlink !== 1 || after.nlink !== 1 || after.size !== 0
          || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
          || named.dev !== opened.dev || named.ino !== opened.ino) {
          throw new Error('Pinned install config file changed during creation.');
        }
      } finally { fs.closeSync(fd); }
    }
    process.stdout.write(JSON.stringify({ canonicalPath, device: captured.dev, inode: captured.ino }));
    return;
  }
  if (operation === 'ensure-directory') {
    let before;
    try {
      before = fs.lstatSync(prepared.target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(prepared.target);
      before = fs.lstatSync(prepared.target);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('Pinned workspace directory target is unsafe.');
    }
    await waitForStep(prepared.leaf);
    process.chdir(prepared.target);
    const captured = fs.lstatSync('.');
    const canonicalPath = fs.realpathSync('.');
    if (!captured.isDirectory() || captured.isSymbolicLink()
      || captured.dev !== before.dev || captured.ino !== before.ino) {
      throw new Error('Pinned workspace directory changed during capture.');
    }
    process.stdout.write(JSON.stringify({
      canonicalPath, device: captured.dev, inode: captured.ino,
    }));
    return;
  }
  if (operation === 'ensure-file') {
    const injectedContent = process.env.O8_PINNED_ENSURE_CONTENT;
    const expected = injectedContent === undefined
      ? Buffer.concat(await Array.fromAsync(process.stdin))
      : Buffer.from(injectedContent, 'base64');
    let created = false;
    let handle;
    try {
      handle = fs.openSync(prepared.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      handle = fs.openSync(
        prepared.target,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    }
    try {
      const receipt = fs.fstatSync(handle);
      if (!receipt.isFile() || receipt.nlink !== 1) {
        throw new Error('Pinned workspace ensured target is not exclusively linked.');
      }
      await waitForStep('ensure-file-opened');
      if (created) {
        fs.writeSync(handle, expected, 0, expected.length, 0);
        fs.fsyncSync(handle);
      }
      const actual = Buffer.alloc(expected.length);
      fs.readSync(handle, actual, 0, actual.length, 0);
      const after = fs.fstatSync(handle);
      if (!actual.equals(expected) || after.nlink !== 1 || after.size !== expected.length) {
        throw new Error('Pinned workspace ensured file has unexpected contents.');
      }
      const published = fs.lstatSync(prepared.target);
      if (!published.isFile() || published.isSymbolicLink()
        || published.nlink !== 1
        || published.dev !== receipt.dev || published.ino !== receipt.ino) {
        throw new Error('Pinned workspace publish moved an unexpected ensured file.');
      }
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  try {
    fs.lstatSync(prepared.target);
    process.exitCode = 45;
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (operation === 'clone-tree') {
    const input = JSON.parse(process.argv[3]);
    const receipt = await cloneDirectory(input.source, prepared.target);
    if (!receipt) process.exitCode = 46;
    else process.stdout.write(JSON.stringify(receipt));
  }
  else if (operation === 'copy-file') await copyFileExact(process.argv[3], prepared.target);
  else if (operation === 'symlink') {
    fs.symlinkSync(process.argv[3], prepared.target);
    const receipt = fs.lstatSync(prepared.target);
    await waitForStep('symlink-created');
    const published = fs.lstatSync(prepared.target);
    if (!receipt.isSymbolicLink() || receipt.nlink !== 1
      || !published.isSymbolicLink() || published.nlink !== 1
      || published.dev !== receipt.dev || published.ino !== receipt.ino
      || fs.readlinkSync(prepared.target) !== process.argv[3]) {
      throw new Error('Pinned workspace symlink target changed before its receipt.');
    }
  }
  else if (operation === 'copy-tree') {
    const sourcePath = process.argv[3];
    const sourceFingerprint = fingerprintTree(sourcePath);
    const sourceIdentity = fs.lstatSync(sourcePath);
    if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink()) {
      throw new Error('Pinned hydration tree source is not a directory.');
    }
    await waitForStep('source-reproved');
    fs.mkdirSync(prepared.target, sourceIdentity.mode & 0o777);
    const targetIdentity = fs.lstatSync(prepared.target);
    const publicTarget = path.join(process.cwd(), prepared.target);
    await waitForStep('target-created');
    process.chdir(prepared.target);
    const capturedTarget = fs.lstatSync('.');
    if (!capturedTarget.isDirectory() || capturedTarget.isSymbolicLink()
      || capturedTarget.dev !== targetIdentity.dev || capturedTarget.ino !== targetIdentity.ino) {
      throw new Error('Pinned hydration target changed before population.');
    }
    const names = fs.readdirSync(sourcePath).sort();
    for (const name of names) {
      await copyTree(path.join(sourcePath, name), name);
    }
    await waitForStep('source-copied');
    if (fingerprintTree(sourcePath) !== sourceFingerprint
      || fingerprintTree('.') !== sourceFingerprint) {
      throw new Error('Pinned hydration source changed during direct population.');
    }
    const publishedIdentity = fs.lstatSync(publicTarget);
    if (!publishedIdentity.isDirectory() || publishedIdentity.isSymbolicLink()
      || publishedIdentity.dev !== targetIdentity.dev
      || publishedIdentity.ino !== targetIdentity.ino) {
      throw new Error('Pinned hydration direct target lost its exact namespace.');
    }
  }
  else throw new Error('Pinned workspace operation is unsupported.');
}

void main().then(() => {
  process.stdin.destroy();
}).catch((error) => {
  process.stdin.destroy();
  console.error('[workspace-materialization] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
`;

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe pinned workspace path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function runPinnedLeaf(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  operation: 'read' | 'inspect-entry' | 'atomic-write' | 'copy-file' | 'symlink' | 'copy-tree' | 'clone-tree' | 'ensure-directory' | 'ensure-file' | 'create-install-runtime',
  relativePath: string,
  sourceOrTarget?: string,
  content?: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
  expectedTargetIdentity?: PinnedWorkspaceFileIdentity | null,
): Promise<{ code: number; stdout: string }> {
  const args = [
    operation, safeRelativePath(relativePath),
    ...(sourceOrTarget ? [sourceOrTarget] : []),
  ];
  if ((operation === 'read' || operation === 'inspect-entry') && !afterPinnedStep) {
    const pending = tryPinnedWorkspaceRead(workspacePath, identity, operation, args.slice(1));
    if (pending) return pending;
  }
  const invocation = guardedWorkspaceScriptInvocation(PINNED_LEAF_IO_SCRIPT, args, identity);
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspacePath,
    env: childEnvironment({ env: { ...(afterPinnedStep ? { O8_PINNED_STEP_HANDSHAKE: '1' } : {}), ...(afterPinnedStep && operation === 'atomic-write'
        ? { O8_PINNED_ATOMIC_CONTENT: Buffer.from(content ?? '').toString('base64') }
        : {}), ...(afterPinnedStep && operation === 'ensure-file'
        ? { O8_PINNED_ENSURE_CONTENT: Buffer.from(content ?? '').toString('base64') }
        : {}), ...(operation === 'atomic-write' && expectedTargetIdentity !== undefined
        ? { O8_PINNED_EXPECTED_TARGET: JSON.stringify(expectedTargetIdentity) }
        : {}) } }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let stepQueue = Promise.resolve();
  child.stdout.on('data', (chunk: Buffer) => {
    pendingStdout += chunk.toString('utf8');
    if (!afterPinnedStep) return;
    for (;;) {
      const newline = pendingStdout.indexOf('\n');
      if (newline < 0) break;
      const line = pendingStdout.slice(0, newline);
      pendingStdout = pendingStdout.slice(newline + 1);
      const match = /^O8_PINNED_STEP ([A-Za-z0-9_-]+)$/.exec(line);
      if (!match?.[1]) {
        stdout += `${line}\n`;
        continue;
      }
      const segment = Buffer.from(match[1], 'base64url').toString('utf8');
      stepQueue = stepQueue.then(() => afterPinnedStep(segment)).then(() => {
        child.stdin.write('continue\n');
      });
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  if (!afterPinnedStep) child.stdin.end(content ?? '');
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await stepQueue;
  child.stdin.end();
  stdout += pendingStdout;
  if (code === null) throw new Error('Pinned workspace operation ended without an exit receipt.');
  if (code !== 0 && code !== 44 && code !== 45 && !(code === 46 && operation === 'clone-tree')) {
    const message = stderr.trim() || 'Pinned workspace operation failed.';
    if (operation === 'copy-tree' || operation === 'clone-tree'
      || (operation === 'copy-file'
        && (message.includes('copied target') || message.includes('target did not match')))
      || (operation === 'symlink' && message.includes('symlink target changed'))
      || message.includes('publish moved an unexpected')
      || message.includes('direct write lost its exact target')
      || message.includes('direct-write target is not exclusively linked')
      || message.includes('target changed before direct write')
      || message.includes('hydration target changed before population')
      || message.includes('hydration direct target lost its exact namespace')
      || message.includes('hydration source changed')) {
      throw new PinnedWorkspacePublishError(message);
    }
    throw new Error(message);
  }
  if (operation === 'clone-tree' && process.env.O8_DEPENDENCY_CLONE_PROFILE === '1') {
    const native = stderr.match(/^\[dependency-clone-native-ms\] (\d+)$/m);
    if (native) console.log('[dependency-clone-profile]', JSON.stringify({ stage: 'native-directory-clone', durationMs: Number(native[1]) }));
  }
  return { code, stdout };
}

export async function readPinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<string | null> {
  const receipt = await readPinnedWorkspaceFileReceipt(workspacePath, identity, relativePath);
  return receipt?.content ?? null;
}

export async function readPinnedWorkspaceFileReceipt(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<{ content: string } & Required<PinnedWorkspaceFileIdentity> | null> {
  const limit = relativePath === '.meta.json' ? worktreeMetadataReadLimit() : undefined;
  const receipt = await runPinnedLeaf(workspacePath, identity, 'read', relativePath,
    limit === undefined ? undefined : String(limit));
  if (receipt.code === 44) return null;
  const parsed = JSON.parse(receipt.stdout) as {
    content?: unknown; device?: unknown; inode?: unknown; canonicalPath?: unknown;
  };
  if (typeof parsed.content !== 'string'
    || !Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)
    || typeof parsed.canonicalPath !== 'string'
    || !path.isAbsolute(parsed.canonicalPath)) {
    throw new Error('Pinned workspace read returned an invalid file receipt.');
  }
  const canonicalPath = parsed.canonicalPath;
  if (relativePath === '.meta.json') {
    chargeWorktreeMetadataRead(canonicalPath, Buffer.from(parsed.content, 'base64').length);
  }
  return {
    content: Buffer.from(parsed.content, 'base64').toString('utf8'),
    device: parsed.device as number,
    inode: parsed.inode as number,
    canonicalPath,
    volumeId: await resolveStorageVolumeId(canonicalPath),
  };
}

export async function inspectPinnedWorkspaceEntry(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<{ kind: 'file' | 'directory' | 'symlink' | 'other'; device: number; inode: number } | null> {
  const receipt = await runPinnedLeaf(workspacePath, identity, 'inspect-entry', relativePath);
  if (receipt.code === 44) return null;
  const parsed = JSON.parse(receipt.stdout) as {
    kind?: unknown; device?: unknown; inode?: unknown;
  };
  if ((parsed.kind !== 'file' && parsed.kind !== 'directory'
      && parsed.kind !== 'symlink' && parsed.kind !== 'other')
    || !Number.isSafeInteger(parsed.device) || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Pinned workspace inspection returned an invalid identity.');
  }
  return parsed as { kind: 'file' | 'directory' | 'symlink' | 'other'; device: number; inode: number };
}

export async function writePinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  content: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
  expectedTargetIdentity?: PinnedWorkspaceFileIdentity | null,
): Promise<Required<PinnedWorkspaceFileIdentity>> {
  let pinnedTargetIdentity = expectedTargetIdentity;
  if (expectedTargetIdentity) {
    const current = await readPinnedWorkspaceFileReceipt(workspacePath, identity, relativePath);
    if (!current) throw new Error('Pinned workspace direct-write target is missing.');
    const expectedCanonicalPath = expectedTargetIdentity.canonicalPath
      ?? path.join(identity.canonicalPath, safeRelativePath(relativePath));
    if (current.canonicalPath !== expectedCanonicalPath) {
      throw new Error('Pinned workspace direct-write target canonical path does not match its durable receipt.');
    }
    if (current.inode !== expectedTargetIdentity.inode) {
      throw new Error('Pinned workspace direct-write target inode does not match its durable receipt.');
    }
    const expectedVolumeId = expectedTargetIdentity.volumeId
      ?? identity.volumeId
      ?? await resolveStorageVolumeId(identity.canonicalPath);
    if (current.volumeId !== expectedVolumeId) {
      throw new Error('Pinned workspace direct-write target volume identity does not match its durable receipt.');
    }
    pinnedTargetIdentity = { device: current.device, inode: current.inode };
  }
  const receipt = await runPinnedLeaf(
    workspacePath, identity, 'atomic-write', relativePath, undefined, content, afterPinnedStep,
    pinnedTargetIdentity,
  );
  const parsed = JSON.parse(receipt.stdout) as {
    device?: unknown; inode?: unknown; canonicalPath?: unknown;
  };
  if (!Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)
    || typeof parsed.canonicalPath !== 'string'
    || !path.isAbsolute(parsed.canonicalPath)) {
    throw new Error('Pinned workspace direct write returned an invalid target receipt.');
  }
  const canonicalPath = parsed.canonicalPath;
  return {
    device: parsed.device as number,
    inode: parsed.inode as number,
    canonicalPath,
    volumeId: await resolveStorageVolumeId(canonicalPath),
  };
}

export async function ensurePinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  content: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<void> {
  await runPinnedLeaf(
    workspacePath, identity, 'ensure-file', relativePath, undefined, content, afterPinnedStep,
  );
}

export async function createPinnedWorkspaceBinding(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  input: { mode: 'copy-file' | 'symlink' | 'copy-tree' | 'clone-tree'; source: string },
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<'created' | 'exists' | 'unsupported'> {
  const receipt = await runPinnedLeaf(
    workspacePath, identity, input.mode, relativePath,
    input.mode === 'clone-tree' ? JSON.stringify(input) : input.source, undefined, afterPinnedStep,
  );
  if (input.mode === 'clone-tree' && receipt.code === 0 && JSON.parse(receipt.stdout).sourceChanged) {
    throw new PinnedWorkspacePublishError('Pinned clone source changed during cloning.');
  }
  return receipt.code === 46 ? 'unsupported' : receipt.code === 45 ? 'exists' : 'created';
}

async function pinnedDirectoryOperation(
  operation: 'ensure-directory' | 'create-install-runtime',
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<WorktreeMaterializationIdentity> {
  const receipt = await runPinnedLeaf(
    workspacePath, identity, operation, relativePath, undefined, undefined, afterPinnedStep,
  );
  const parsed = JSON.parse(receipt.stdout) as Partial<WorktreeMaterializationIdentity>;
  if (!Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)
    || typeof parsed.canonicalPath !== 'string'
    || !path.isAbsolute(parsed.canonicalPath)) {
    throw new Error('Pinned workspace directory returned an invalid identity.');
  }
  const result = parsed as WorktreeMaterializationIdentity;
  return { ...result, volumeId: await resolveStorageVolumeId(result.canonicalPath) };
}

export function ensurePinnedWorkspaceDirectory(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<WorktreeMaterializationIdentity> {
  return pinnedDirectoryOperation('ensure-directory', workspacePath, identity, relativePath, afterPinnedStep);
}

/** Create the fixed private installer scaffold in one captured-cwd child. */
export function createPinnedInstallRuntime(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<WorktreeMaterializationIdentity> {
  return pinnedDirectoryOperation('create-install-runtime', workspacePath, identity, relativePath, afterPinnedStep);
}

/** The native publication receipt is the only authority for discarding a clone. */
export async function clonePinnedWorkspaceDirectory(
  workspacePath: string, identity: WorktreeMaterializationIdentity, relativePath: string, source: string,
): Promise<{ disposition: 'created'; device: number; inode: number; sourceChanged: boolean } | { disposition: 'exists' | 'unsupported' }> {
  const result = await runPinnedLeaf(workspacePath, identity, 'clone-tree', relativePath, JSON.stringify({ source }));
  if (result.code !== 0) return { disposition: result.code === 46 ? 'unsupported' : 'exists' };
  const receipt = JSON.parse(result.stdout) as { device: number; inode: number; sourceChanged: boolean };
  if (!Number.isSafeInteger(receipt.device) || !Number.isSafeInteger(receipt.inode)) throw new PinnedWorkspacePublishError('Invalid native clone identity.');
  return { disposition: 'created', ...receipt };
}
