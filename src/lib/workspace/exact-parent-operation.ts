import { execFile, spawn } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';

import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

const execFileAsync = promisify(execFile);

const EXACT_PARENT_OPERATION = String.raw`
const fs = require('node:fs');
const operation = JSON.parse(process.argv[1]);
function readSignal() {
  const bytes = [];
  const byte = Buffer.alloc(1);
  while (true) {
    const count = fs.readSync(0, byte, 0, 1, null);
    if (count === 0) return null;
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8');
    bytes.push(byte[0]);
  }
}
function kindOf(stat) {
  return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}
function requireChildName(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Exact parent operation refused an invalid child name.');
  }
}
if (operation.kind === 'promote') {
  requireChildName(operation.source);
  requireChildName(operation.destination);
  function parent(expected) {
    const stat = fs.lstatSync(expected.canonicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.device
      || stat.ino !== expected.inode || fs.realpathSync(expected.canonicalPath) !== expected.canonicalPath) {
      throw new Error('Exact promotion refused a changed parent identity.');
    }
  }
  parent(operation.sourceParent);
  parent(operation.destinationParent);
  if (operation.sourceParent.device !== operation.destinationParent.device) {
    throw new Error('Exact promotion refused a cross-device transfer.');
  }
  const destination = require('node:path').join(operation.destinationParent.canonicalPath, operation.destination);
  try {
    fs.lstatSync(destination);
    throw new Error('Exact promotion refused an occupied destination.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = fs.lstatSync(operation.source);
  if (source.dev !== operation.device || source.ino !== operation.inode
    || kindOf(source) !== operation.entryKind || (source.isFile() && source.nlink !== 1)) {
    throw new Error('Exact promotion refused a changed source identity.');
  }
  parent(operation.sourceParent);
  parent(operation.destinationParent);
  fs.renameSync(operation.source, destination);
  parent(operation.sourceParent);
  parent(operation.destinationParent);
  const moved = fs.lstatSync(destination);
  if (moved.dev !== operation.device || moved.ino !== operation.inode || kindOf(moved) !== operation.entryKind) {
    throw new Error('Exact promotion moved an unexpected identity.');
  }
} else if (operation.kind === 'write') {
  requireChildName(operation.name);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  // Contents arrive on stdin: a single argv string is capped (128 KiB on Linux).
  const contents = fs.readFileSync(0);
  if (contents.length !== operation.byteLength
    || require('node:crypto').createHash('sha256').update(contents).digest('hex') !== operation.sha256) {
    throw new Error('Exact parent write received unexpected contents.');
  }
  const fd = fs.openSync(operation.name, flags, operation.mode);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
} else if (operation.kind === 'mkdir') {
  requireChildName(operation.name);
  fs.mkdirSync(operation.name, { mode: operation.mode });
  const created = fs.lstatSync(operation.name);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error('Exact parent creation did not produce a regular directory.');
  }
  process.stdout.write(JSON.stringify({ device: created.dev, inode: created.ino }));
} else if (operation.kind === 'mkdir-held') {
  requireChildName(operation.name);
  if (readSignal() !== 'start') process.exit(0);
  fs.mkdirSync(operation.name, { mode: operation.mode });
  const created = fs.lstatSync(operation.name);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error('Exact parent creation did not produce a regular directory.');
  }
  const parentFd = fs.openSync('.', fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  process.stdout.write(JSON.stringify({
    phase: 'created', device: created.dev, inode: created.ino,
  }) + '\n');
  if (readSignal() !== 'claim') process.exit(0);
  const runtimeRequire = require('node:module').createRequire(operation.claimAuthority.sqliteModuleAnchor);
  const Database = runtimeRequire('better-sqlite3');
  const sqlite = new Database(operation.claimAuthority.databasePath);
  try {
    sqlite.pragma('busy_timeout = 5000');
    const result = sqlite.prepare(
      "UPDATE workspace_exact_claims SET state = 'claimed', claim_device = ?, claim_inode = ?, updated_at = ? "
      + "WHERE kind = 'restore-creation' AND repository_path = ? AND worktree_id = ? "
      + "AND operation_id = ? AND state = 'prepared'",
    ).run(
      created.dev,
      created.ino,
      Date.now(),
      operation.claimAuthority.repositoryPath,
      operation.claimAuthority.worktreeId,
      operation.claimAuthority.operationId,
    );
    if (result.changes !== 1) {
      const current = sqlite.prepare(
        "SELECT state, claim_device, claim_inode FROM workspace_exact_claims "
        + "WHERE kind = 'restore-creation' AND repository_path = ? AND worktree_id = ? "
        + 'AND operation_id = ?',
      ).get(
        operation.claimAuthority.repositoryPath,
        operation.claimAuthority.worktreeId,
        operation.claimAuthority.operationId,
      );
      if (!current || current.state !== 'claimed'
        || current.claim_device !== created.dev || current.claim_inode !== created.ino) {
        throw new Error('Exact restore child lost its trusted SQLite claim CAS.');
      }
    }
  } finally {
    sqlite.close();
  }
  process.chdir(operation.name);
  process.stdout.write(JSON.stringify({
    phase: 'claimed', device: created.dev, inode: created.ino,
  }) + '\n');
  readSignal();
  process.exit(0);
} else if (operation.kind === 'rename') {
  requireChildName(operation.source);
  requireChildName(operation.destination);
  try {
    fs.lstatSync(operation.destination);
    throw new Error('Exact parent rename refused an occupied destination.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = fs.lstatSync(operation.source);
  if (source.dev !== operation.device || source.ino !== operation.inode
    || kindOf(source) !== operation.entryKind) {
    throw new Error('Exact parent rename refused a changed source identity.');
  }
  fs.renameSync(operation.source, operation.destination);
  const moved = fs.lstatSync(operation.destination);
  if (moved.dev !== operation.device || moved.ino !== operation.inode
    || kindOf(moved) !== operation.entryKind) {
    throw new Error('Exact parent rename moved an unexpected source identity.');
  }
} else if (operation.kind === 'remove-empty-directory') {
  requireChildName(operation.name);
  const source = fs.lstatSync(operation.name);
  if (!source.isDirectory() || source.isSymbolicLink()
    || source.dev !== operation.device || source.ino !== operation.inode) {
    throw new Error('Exact parent removal refused a changed directory identity.');
  }
  if (fs.readdirSync(operation.name).length !== 0) {
    throw new Error('Exact parent removal refused a non-empty directory.');
  }
  fs.rmdirSync(operation.name);
} else if (operation.kind === 'remove-unreceipted-empty-directory') {
  requireChildName(operation.name);
  const source = fs.lstatSync(operation.name);
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error('Exact parent recovery refused a non-directory claim leaf.');
  }
  if (fs.readdirSync(operation.name).length !== 0) {
    throw new Error('Exact parent recovery refused a non-empty claim leaf.');
  }
  fs.rmdirSync(operation.name);
} else if (operation.kind === 'retire-file') {
  requireChildName(operation.source);
  requireChildName(operation.destination);
  try {
    fs.lstatSync(operation.destination);
    throw new Error('Exact file retirement refused an occupied destination.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = fs.lstatSync(operation.source);
  if (!source.isFile() || source.isSymbolicLink()
    || source.dev !== operation.device || source.ino !== operation.inode) {
    throw new Error('Exact file retirement refused a changed source identity.');
  }
  fs.renameSync(operation.source, operation.destination);
  const moved = fs.lstatSync(operation.destination);
  if (!moved.isFile() || moved.isSymbolicLink()
    || moved.dev !== operation.device || moved.ino !== operation.inode) {
    throw new Error('Exact file retirement moved an unexpected source identity.');
  }
  const fd = fs.openSync(operation.destination, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const captured = fs.fstatSync(fd);
    if (!captured.isFile() || captured.dev !== operation.device || captured.ino !== operation.inode) {
      throw new Error('Exact file retirement handle captured an unexpected identity.');
    }
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const released = fs.lstatSync(operation.destination);
  if (released.dev !== operation.device || released.ino !== operation.inode || released.size !== 0) {
    throw new Error('Exact file retirement identity changed before namespace release.');
  }
  fs.unlinkSync(operation.destination);
} else if (operation.kind === 'read-file') {
  requireChildName(operation.name);
  const before = fs.lstatSync(operation.name);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Exact parent read refused a non-file child.');
  }
  const contents = fs.readFileSync(operation.name, 'utf8');
  const after = fs.lstatSync(operation.name);
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Exact parent read child changed during capture.');
  }
  process.stdout.write(JSON.stringify({
    contents,
    device: after.dev,
    inode: after.ino,
  }));
} else if (operation.kind === 'list') {
  process.stdout.write(JSON.stringify(fs.readdirSync('.').filter((name) => (
    typeof operation.prefix !== 'string' || name.startsWith(operation.prefix)
  ))));
} else {
  throw new Error('Exact parent operation is unknown.');
}

`;

function childName(parentPath: string, candidatePath: string): string {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  if (path.dirname(candidate) !== parent) {
    throw new Error('Exact parent operation refused a path outside its captured parent.');
  }
  return path.basename(candidate);
}

async function runExactParentOperation(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  operation: object,
  input?: Buffer,
): Promise<string> {
  const invocation = guardedWorkspaceInvocation(
    process.execPath,
    ['-e', EXACT_PARENT_OPERATION, JSON.stringify(operation)],
    parentIdentity,
  );
  const options = { cwd: parentPath, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 };
  if (input === undefined) {
    const { stdout } = await execFileAsync(invocation.command, invocation.args, options);
    return stdout;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(invocation.command, invocation.args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
    // A child that exits early closes the pipe; its exit status carries the failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function readExactChildFile(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  filePath: string,
): Promise<{ contents: string; identity: { device: number; inode: number } }> {
  const output = await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'read-file',
    name: childName(parentPath, filePath),
  });
  const parsed = JSON.parse(output) as {
    contents?: unknown;
    device?: unknown;
    inode?: unknown;
  };
  if (typeof parsed.contents !== 'string'
    || !Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Exact parent read returned an invalid receipt.');
  }
  return {
    contents: parsed.contents,
    identity: { device: Number(parsed.device), inode: Number(parsed.inode) },
  };
}

export async function listExactChildNames(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  prefix: string,
): Promise<string[]> {
  const output = await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'list',
    prefix,
  });
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
    throw new Error('Exact parent listing returned invalid child names.');
  }
  return parsed;
}

export async function writeExactChildFile(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const bytes = Buffer.from(contents, 'utf8');
  await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'write',
    name: childName(parentPath, filePath),
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode,
  }, bytes);
}

export async function createExactChildDirectory(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  directoryPath: string,
  mode = 0o700,
): Promise<{ device: number; inode: number }> {
  const output = await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'mkdir',
    name: childName(parentPath, directoryPath),
    mode,
  });
  const parsed = JSON.parse(output) as { device?: unknown; inode?: unknown };
  if (!Number.isSafeInteger(parsed.device) || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Exact parent creation returned an invalid directory receipt.');
  }
  return { device: Number(parsed.device), inode: Number(parsed.inode) };
}

/** Hold the created directory open while its exact inode receipt is durably published. */
export async function createExactChildDirectoryWithReceipt(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  directoryPath: string,
  claimAuthority: {
    sqliteModuleAnchor: string;
    databasePath: string;
    repositoryPath: string;
    worktreeId: string;
    operationId: string;
  },
  publishReceipt: (identity: { device: number; inode: number }) => Promise<void>,
  beforeCreateSignal?: () => Promise<void>,
  beforeClaimCas?: () => Promise<void>,
  mode = 0o700,
): Promise<{ device: number; inode: number }> {
  const { bindExactWorkspaceClaimCreator } = await import('./exact-workspace-claim-state');
  const operation = {
    kind: 'mkdir-held',
    name: childName(parentPath, directoryPath),
    claimAuthority,
    mode,
  };
  const invocation = guardedWorkspaceInvocation(
    process.execPath,
    ['-e', EXACT_PARENT_OPERATION, JSON.stringify(operation)],
    parentIdentity,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: parentPath,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close') as Promise<[number | null]>;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const pid = child.pid;
  if (!pid) {
    child.stdin.end();
    throw new Error('Exact parent creation did not publish a child PID.');
  }
  const processProbe = await probeMetadataLockProcessIdentity(pid);
  if (processProbe.state !== 'live') {
    child.stdin.end();
    throw new Error('Exact parent creation could not prove its child process identity.');
  }
  try {
    bindExactWorkspaceClaimCreator({
      repositoryPath: claimAuthority.repositoryPath,
      worktreeId: claimAuthority.worktreeId,
      operationId: claimAuthority.operationId,
      pid,
      processIdentity: processProbe.identity,
    });
    await beforeCreateSignal?.();
    child.stdin.write('start\n');
    const waitForLines = async (count: number): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (stdout.split('\n').length - 1 < count && child.exitCode === null) {
        if (Date.now() >= deadline) {
          child.kill('SIGTERM');
          throw new Error('Exact parent creation receipt timed out.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (stdout.split('\n').length - 1 < count) {
        const [code] = await closed;
        throw new Error(stderr.trim() || `Exact parent creation exited ${code}.`);
      }
    };
    await waitForLines(1);
    const created = JSON.parse(stdout.split('\n')[0]!) as {
      phase?: unknown;
      device?: unknown;
      inode?: unknown;
    };
    if (created.phase !== 'created'
      || !Number.isSafeInteger(created.device)
      || !Number.isSafeInteger(created.inode)) {
      throw new Error('Exact parent creation returned an invalid pre-claim receipt.');
    }
    await beforeClaimCas?.();
    child.stdin.write('claim\n');
    await waitForLines(2);
    const claimed = JSON.parse(stdout.split('\n')[1]!) as {
      phase?: unknown;
      device?: unknown;
      inode?: unknown;
    };
    if (claimed.phase !== 'claimed'
      || claimed.device !== created.device || claimed.inode !== created.inode) {
      throw new Error('Exact parent creation returned an invalid claimed receipt.');
    }
    const identity = { device: Number(claimed.device), inode: Number(claimed.inode) };
    await publishReceipt(identity);
    return identity;
  } finally {
    child.stdin.end('receipt-published\n');
    await closed;
  }
}

/** Captured source cwd and checked destination parent; not an atomic no-replace syscall. */
export async function promoteExactChild(
  sourceParent: WorktreeMaterializationIdentity,
  destinationParent: WorktreeMaterializationIdentity,
  sourcePath: string,
  destinationPath: string,
  identity: { device: number; inode: number },
  entryKind: 'file' | 'directory',
): Promise<void> {
  await runExactParentOperation(sourceParent.canonicalPath, sourceParent, {
    kind: 'promote', sourceParent, destinationParent,
    source: childName(sourceParent.canonicalPath, sourcePath),
    destination: childName(destinationParent.canonicalPath, destinationPath),
    device: identity.device, inode: identity.inode, entryKind,
  });
}

export async function renameExactChildDirectory(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  sourcePath: string,
  destinationPath: string,
  sourceIdentity: { device: number; inode: number },
): Promise<void> {
  await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'rename',
    source: childName(parentPath, sourcePath),
    destination: childName(parentPath, destinationPath),
    device: sourceIdentity.device,
    inode: sourceIdentity.inode,
    entryKind: 'directory',
  });
}

export async function removeExactEmptyChildDirectory(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  directoryPath: string,
  directoryIdentity: { device: number; inode: number },
): Promise<void> {
  await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'remove-empty-directory',
    name: childName(parentPath, directoryPath),
    device: directoryIdentity.device,
    inode: directoryIdentity.inode,
  });
}

/** Remove only an unreceipted empty claim leaf; any content or non-directory refuses. */
export async function removeExactUnreceiptedEmptyChildDirectory(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  directoryPath: string,
): Promise<void> {
  await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'remove-unreceipted-empty-directory',
    name: childName(parentPath, directoryPath),
  });
}

export async function retireExactChildFile(
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  filePath: string,
  retiredPath: string,
  fileIdentity: { device: number; inode: number },
): Promise<void> {
  await runExactParentOperation(parentPath, parentIdentity, {
    kind: 'retire-file',
    source: childName(parentPath, filePath),
    destination: childName(parentPath, retiredPath),
    device: fileIdentity.device,
    inode: fileIdentity.inode,
  });
}
