import { resolveGitBinary } from '@/lib/git/binary';
import { timeClosePhase } from '@/lib/orchestrator/close-timing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { laneGitArguments, laneGitEnvironment, laneGitInvocationAsync } from '@/lib/lane/lane-git';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { guardedWorkspaceInvocation, materializationAwareExecFile, materializationAwareNodeSettlement, type MaterializationExecutionSettlement, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';

import { assertPreservationBankAdmission, beginPreservationBankWriter, PRESERVATION_BANK_POLICY, type PreservationBankAdmission } from './preservation-bank-budget';

const MAX_BUNDLE_BYTES = PRESERVATION_BANK_POLICY.bundleBytes;

export interface WorkspaceGitBundleReceipt {
  schema: 'o8/workspace-git-bundle/v1';
  sha256: string;
  bytes: number;
  objectFormat: 'sha1' | 'sha256';
  repositoryUuid: string;
  packetId: string;
  snapshotGeneration: number;
  snapshotFingerprint: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  prerequisiteCount: 0;
  commitCount: number;
  objectCount: number;
}

const gitEnvironment = () => laneGitEnvironment(true);

async function privateDirectory(directory: string): Promise<WorktreeMaterializationIdentity> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new Error('The private Git preservation directory has unsafe ownership.');
  }
  return captureWorktreeMaterializationIdentity(directory);
}

async function bundleDirectory() {
  const data = await realpath(getDataDir());
  const bank = path.join(data, 'workspace-preservation');
  const bankIdentity = await privateDirectory(bank);
  const directory = path.join(bank, 'git-bundles');
  const identity = await privateDirectory(directory);
  await assertWorktreeMaterializationIdentity(bank, bankIdentity);
  return { directory, identity, bankIdentity };
}

async function assertBank(bank: Awaited<ReturnType<typeof bundleDirectory>>) {
  await assertWorktreeMaterializationIdentity(path.dirname(bank.directory), bank.bankIdentity);
  await assertWorktreeMaterializationIdentity(bank.directory, bank.identity);
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.uid === after.uid && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readBundleFile(candidate: string): Promise<{ content: Buffer; stat: Stats; sha256: string }> {
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BUNDLE_BYTES
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0) || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('The Git bundle exceeds its bound or has unsafe file ownership.');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw new Error('The Git bundle changed during descriptor read.');
      offset += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(candidate);
    if (!sameFile(before, after) || !sameFile(after, named) || named.isSymbolicLink()) {
      throw new Error('The private Git bundle changed during receipt verification.');
    }
    return { content, stat: after, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await file.close();
  }
}

export async function readWorkspaceGitBundle(receipt: WorkspaceGitBundleReceipt): Promise<Buffer> {
  const oid = receipt.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (receipt.schema !== 'o8/workspace-git-bundle/v1' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > MAX_BUNDLE_BYTES
    || !['sha1', 'sha256'].includes(receipt.objectFormat) || !oid.test(receipt.headCommit) || !oid.test(receipt.treeSha)
    || !Number.isSafeInteger(receipt.commitCount) || receipt.commitCount < 1
    || !Number.isSafeInteger(receipt.objectCount) || receipt.objectCount < receipt.commitCount
    || receipt.prerequisiteCount !== 0 || !Number.isSafeInteger(receipt.snapshotGeneration) || receipt.snapshotGeneration < 1
    || !receipt.recoveryRef.startsWith('refs/o8/recovery/')) {
    throw new Error('The portable Git bundle receipt is invalid.');
  }
  const bank = await bundleDirectory();
  const result = await readBundleFile(path.join(bank.directory, receipt.sha256 + '.bundle'));
  await assertBank(bank);
  if (result.sha256 !== receipt.sha256 || result.content.length !== receipt.bytes) {
    throw new Error('The portable Git bundle failed its trusted hash or size receipt.');
  }
  return result.content;
}

const writerAttempts = new AsyncLocalStorage<{ admission: PreservationBankAdmission; settlements: MaterializationExecutionSettlement[] }>();

async function executePreservationNode(
  script: string, payload: unknown, identity: WorktreeMaterializationIdentity,
  env: NodeJS.ProcessEnv, maxBuffer = 1024 * 1024,
): Promise<MaterializationExecutionSettlement> {
  const attempt = writerAttempts.getStore();
  const finish = attempt ? beginPreservationBankWriter(attempt.admission) : null;
  const settlement = await materializationAwareNodeSettlement({ script, payload, identity, env, maxBuffer });
  finish?.(settlement.settled);
  attempt?.settlements.push(settlement);
  if (!settlement.ok) {
    throw Object.assign(new Error(settlement.reason + (settlement.stderr ? ': ' + settlement.stderr : '')), { settlement });
  }
  return settlement;
}

async function preservationGitValueNative(cwd: string, identity: WorktreeMaterializationIdentity, args: string[]): Promise<string> {
  return withWorktreeMaterializationExecution(cwd, identity, async () => {
    // Private empty verifiers have no lane metadata or configured drivers.
    const invocation = args[0] === 'init' || args[0]?.startsWith('--git-dir=verify.git')
      ? { args: laneGitArguments(args), env: gitEnvironment() }
      : await laneGitInvocationAsync(cwd, cwd, args, true);
    const { stdout } = args[0] === 'init' || args[0]?.startsWith('--git-dir=verify.git')
      ? await executePreservationNode(
        `const input = JSON.parse(process.argv[1]); await runChild(input.command, input.args);`,
        guardedWorkspaceInvocation('git', invocation.args, identity), identity, invocation.env, PRESERVATION_BANK_POLICY.gitOutputBytes,
      )
      : await materializationAwareExecFile('git', invocation.args, {
        cwd, env: invocation.env, timeout: 120_000, maxBuffer: PRESERVATION_BANK_POLICY.gitOutputBytes,
      });
    return stdout.trim();
  });
}

// Each process receives an OS-captured cwd. macOS cannot traverse directory
// descriptors through /dev/fd; only the regular bundle descriptor crosses cwd boundaries.
const PREPARE_DIRECTORY = String.raw`
const fs = require('node:fs');
const leaf = fs.mkdtempSync('.prepare-');
const stat = fs.lstatSync(leaf);
if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  || (process.getuid && stat.uid !== process.getuid())) throw new Error('Verifier ownership is unsafe.');
process.stdout.write(JSON.stringify({ leaf, device: stat.dev, inode: stat.ino }));
`;

const CAPTURE_BUNDLE = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
const fd = fs.openSync('source.bundle', fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
let bytes = 0;
try {
  await runChild(input.invocation.command, input.invocation.args, {
    cwd: input.repositoryPath,
    stdout(chunk) {
      bytes += chunk.length;
      if (bytes > input.maxBytes) throw new Error('Portable Git source exceeds the bounded preservation budget.');
      let offset = 0;
      while (offset < chunk.length) {
        const count = fs.writeSync(fd, chunk, offset, chunk.length - offset);
        if (!count) throw new Error('Portable Git bundle descriptor write was incomplete.');
        offset += count;
      }
    },
  });
  fs.fsyncSync(fd);
} finally { fs.closeSync(fd); }
`;

async function capturePreservationGitBundleNative(snapshot: WorkspaceSnapshotRecord, repositoryPath: string,
  repositoryIdentity: WorktreeMaterializationIdentity, preparation: string, identity: WorktreeMaterializationIdentity) {
  const safe = await laneGitInvocationAsync(repositoryPath, repositoryPath, [
    'bundle', 'create', '--version=3', '-', snapshot.recoveryRef,
  ], true);
  const invocation = guardedWorkspaceInvocation('git', safe.args, repositoryIdentity);
  return executePreservationNode(CAPTURE_BUNDLE, { invocation, repositoryPath, maxBytes: MAX_BUNDLE_BYTES }, identity, safe.env);
}

const PUBLISH_FROM_DESCRIPTOR = String.raw`
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const input = JSON.parse(process.argv[1]);
const directory = fs.lstatSync('.');
if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
  || (process.getuid && directory.uid !== process.getuid())
  || directory.dev !== input.bankIdentity.device || directory.ino !== input.bankIdentity.inode
  || fs.realpathSync('.') !== input.bankIdentity.canonicalPath) {
  throw new Error('Captured publication bank ownership changed.');
}
function sameOwner(stat, expected) {
  return stat.isFile() && !stat.isSymbolicLink() && (process.platform === 'win32' || !(stat.mode & 0o077))
    && (!process.getuid || stat.uid === process.getuid())
    && stat.dev === expected.device && stat.ino === expected.inode;
}
const source = fs.fstatSync(3);
if (!sameOwner(source, input.file) || source.nlink !== 1 || source.size !== input.bytes
  || input.bytes < 1 || input.bytes > input.maxBytes || !/^[a-f0-9]{64}$/.test(input.sha256)) {
  throw new Error('Bundle publication descriptor changed.');
}
const staging = '.publish-' + randomBytes(16).toString('hex');
const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
const owner = fs.fstatSync(fd);
try {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  while (bytes < input.bytes) {
    const count = fs.readSync(3, buffer, 0, Math.min(buffer.length, input.bytes - bytes), bytes);
    if (!count) throw new Error('Bundle source changed during publication.');
    hash.update(buffer.subarray(0, count));
    let offset = 0;
    while (offset < count) {
      const written = fs.writeSync(fd, buffer, offset, count - offset);
      if (!written) throw new Error('Bundle publication write was incomplete.');
      offset += written;
    }
    bytes += count;
  }
  const after = fs.fstatSync(3);
  if (hash.digest('hex') !== input.sha256 || after.size !== source.size
    || after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs || after.nlink !== source.nlink
    || after.mode !== source.mode || after.uid !== source.uid || !sameOwner(after, input.file)) {
    throw new Error('Bundle publication failed the verified hash or source identity.');
  }
  fs.fsyncSync(fd);
  const expected = { device: owner.dev, inode: owner.ino };
  if (!sameOwner(fs.lstatSync(staging), expected)) throw new Error('Publication staging name changed.');
  try { fs.linkSync(staging, input.sha256 + '.bundle'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
} finally {
  fs.closeSync(fd);
  if (!sameOwner(fs.lstatSync(staging), { device: owner.dev, inode: owner.ino })) {
    throw new Error('Unknown publication staging entry retained.');
  }
  fs.unlinkSync(staging);
  const bankFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(bankFd); } finally { fs.closeSync(bankFd); }
}
`;

const BANK_OPERATION = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
const directory = fs.lstatSync('.');
if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
  || (process.getuid && directory.uid !== process.getuid())
  || directory.dev !== input.identity.device || directory.ino !== input.identity.inode) {
  throw new Error('Private verifier ownership changed.');
}
if (input.operation === 'publish') {
  const fd = fs.openSync('source.bundle', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    await runChild(input.bankInvocation.command, [], {
      cwd: input.bankDirectory, fd,
      nodeScript: input.bankInvocation.args[1], payload: JSON.parse(input.bankInvocation.args[2]),
    });
    const named = fs.lstatSync('source.bundle');
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== input.file.device
      || named.ino !== input.file.inode) throw new Error('Bundle source name changed; retained for inspection.');
    fs.unlinkSync('source.bundle');
  } finally { fs.closeSync(fd); }
} else if (input.operation === 'remove') {
  for (const name of fs.readdirSync('.')) fs.rmSync(name, { recursive: true, force: false });
} else throw new Error('Private bank operation is invalid.');
`;

const REMOVE_DIRECTORY = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
if (!/^\.prepare-[a-zA-Z0-9]+$/.test(input.leaf)) throw new Error('Verifier name is invalid.');
const stat = fs.lstatSync(input.leaf);
if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  || (process.getuid && stat.uid !== process.getuid())
  || stat.dev !== input.identity.device || stat.ino !== input.identity.inode) {
  throw new Error('Unknown verifier entry retained.');
}
fs.rmdirSync(input.leaf);
const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
`;

interface BankOperationInput {
  operation: 'publish' | 'remove';
  leaf: string;
  identity: WorktreeMaterializationIdentity;
  sha256?: string;
  bytes?: number;
  file?: { device: number; inode: number };
}

export async function executePreservationBankOperation(bank: Awaited<ReturnType<typeof bundleDirectory>>, input: BankOperationInput) {
  await assertBank(bank);
  // execve closes descriptors beyond stdio. This child validates its captured
  // bank cwd directly so the inherited regular-file descriptor remains open.
  const bankInvocation = { command: process.execPath, args: ['-e', PUBLISH_FROM_DESCRIPTOR,
    JSON.stringify({ bankIdentity: bank.identity, sha256: input.sha256, bytes: input.bytes,
      file: input.file, maxBytes: MAX_BUNDLE_BYTES })] };
  const settlement = await executePreservationNode(BANK_OPERATION, { ...input, bankInvocation, bankDirectory: bank.directory }, input.identity, gitEnvironment());
  if (input.operation === 'remove') {
    await executePreservationNode(REMOVE_DIRECTORY, input, bank.identity, gitEnvironment());
  }
  await assertBank(bank);
  return settlement;
}

/** Prove all source objects in an empty repository before publishing its bank receipt. */
async function preserveWorkspaceGitBundleNative(snapshot: WorkspaceSnapshotRecord, repositoryPath: string, admission: PreservationBankAdmission): Promise<WorkspaceGitBundleReceipt> {
  const settlements: MaterializationExecutionSettlement[] = [];
  try {
    return await writerAttempts.run({ admission, settlements }, () => preserveBundle(snapshot, repositoryPath, admission));
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      writerSettlements: settlements,
      writersSettled: settlements.length > 0 && settlements.every(value => value.settled),
    });
  }
}

async function preserveBundle(snapshot: WorkspaceSnapshotRecord, repositoryPath: string, admission: PreservationBankAdmission): Promise<WorkspaceGitBundleReceipt> {
  assertPreservationBankAdmission(admission);
  if (!snapshot.recoveryRef.startsWith('refs/o8/recovery/')) throw new Error('Portable source needs a protected recovery ref.');
  const repositoryIdentity = await captureWorktreeMaterializationIdentity(repositoryPath);
  const sourceValues = async () => {
    const queries = [
      ['rev-parse', '--verify', snapshot.recoveryRef + '^{commit}'],
      ['rev-parse', '--verify', snapshot.recoveryRef + '^{tree}'],
      ['rev-parse', '--show-object-format'],
      ['rev-list', '--count', snapshot.recoveryRef],
      ['rev-list', '--objects', '--no-object-names', snapshot.recoveryRef],
    ];
    const results = await Promise.allSettled(queries.map(args => preservationGitValue(repositoryPath, repositoryIdentity, args)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const values = results.map(result => (result as PromiseFulfilledResult<string>).value);
    if (values[0] !== snapshot.headCommit || values[1] !== snapshot.treeSha) {
      throw new Error('The protected Git source changed before portable preservation.');
    }
    return { objectFormat: values[2]!, commitCount: Number(values[3]), objectCount: values[4]!.split('\n').length };
  };
  const expected = await sourceValues();
  if (expected.objectFormat !== 'sha1' && expected.objectFormat !== 'sha256') throw new Error('Git object format is unsupported.');
  // rev-list already has a 32 MiB stdout limit (at least 41 bytes per SHA1
  // object line). Reserve 128 bytes/object for packed index/reverse-index and
  // temporary index overhead, plus fixed metadata. No new object-count ceiling.
  const verifierOverhead = expected.objectCount * 128 + 4096;
  const required = 3 * MAX_BUNDLE_BYTES + PRESERVATION_BANK_POLICY.manifestBytes
    + verifierOverhead + PRESERVATION_BANK_POLICY.captureEntries * 65_536 + 16 * 1024 ** 2;
  if (!Number.isSafeInteger(required) || required > PRESERVATION_BANK_POLICY.captureBytes) {
    throw new Error('Portable verifier overhead exceeds its preservation capacity reservation.');
  }
  const bank = await bundleDirectory();
  if (path.dirname(bank.directory) !== admission.directory) throw new Error('Preservation bank reservation differs from publication.');
  const { stdout } = await executePreservationNode(PREPARE_DIRECTORY, {}, bank.identity, gitEnvironment());
  const created = JSON.parse(stdout) as { leaf: string; device: number; inode: number };
  if (!/^\.prepare-[a-zA-Z0-9]+$/.test(created.leaf)) throw new Error('Private verifier name is invalid.');
  const preparation = path.join(bank.directory, created.leaf);
  await assertBank(bank);
  const identity = await privateDirectory(preparation);
  if (identity.device !== created.device || identity.inode !== created.inode) {
    throw new Error('Private verifier changed during ownership capture.');
  }
  const leaf = path.basename(preparation);
  try {
    await assertBank(bank);
    await capturePreservationGitBundle(snapshot, repositoryPath, repositoryIdentity, preparation, identity);
    const before = await readBundleFile(path.join(preparation, 'source.bundle'));
    // One settled wrapper owns the complete empty-repository verifier. Each
    // nested command retains the ready/identity/ack/close writer protocol.
    const commands = [
      ['init', '--bare', '--template=', '--object-format=' + expected.objectFormat, 'verify.git'],
      ['--git-dir=verify.git', 'bundle', 'verify', 'source.bundle'],
      ['--git-dir=verify.git', '-c', 'fetch.unpackLimit=0', '-c', 'gc.auto=0',
        '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false', 'fetch', '--no-tags', '--no-recurse-submodules',
        './source.bundle', snapshot.recoveryRef + ':refs/heads/recovered'],
      ['--git-dir=verify.git', 'fsck', '--full', '--strict'],
      ['--git-dir=verify.git', 'rev-parse', 'refs/heads/recovered^{commit}', 'refs/heads/recovered^{tree}'],
      ['--git-dir=verify.git', 'rev-list', '--count', 'refs/heads/recovered'],
      ['--git-dir=verify.git', 'rev-list', '--objects', '--no-object-names', 'refs/heads/recovered'],
    ].map(args => ({ command: resolveGitBinary(), args: laneGitArguments(args) }));
    const { stdout } = await executePreservationNode(String.raw`
      const input = JSON.parse(process.argv[1]);
      const outputs = [];
      for (const command of input.commands) {
        let output = '';
        await runChild(command.command, command.args, { identity: input.identity, stdout(chunk) {
          output += chunk.toString();
          if (Buffer.byteLength(output) > input.maxBytes) throw new Error('Verifier output exceeded its bound.');
        } });
        outputs.push(output.trim());
      }
      process.stdout.write(JSON.stringify(outputs));
    `, { commands, identity, maxBytes: PRESERVATION_BANK_POLICY.gitOutputBytes }, identity, gitEnvironment(),
    PRESERVATION_BANK_POLICY.gitOutputBytes);
    const outputs = JSON.parse(stdout) as string[];
    if (!Array.isArray(outputs) || outputs.length !== commands.length || outputs.some(value => typeof value !== 'string')) {
      throw new Error('Independent verifier returned an invalid command receipt.');
    }
    const revision = outputs[4]!.split('\n');
    if (revision.length !== 2) throw new Error('Independent verifier revision coverage is incomplete.');
    const recovered = { headCommit: revision[0], treeSha: revision[1],
      commitCount: Number(outputs[5]), objectCount: outputs[6]!.split('\n').length };
    const after = await readBundleFile(path.join(preparation, 'source.bundle'));
    const repeated = await sourceValues();
    if (before.sha256 !== after.sha256 || !sameFile(before.stat, after.stat)
      || recovered.headCommit !== snapshot.headCommit || recovered.treeSha !== snapshot.treeSha
      || recovered.commitCount !== expected.commitCount || recovered.objectCount !== expected.objectCount
      || JSON.stringify(expected) !== JSON.stringify(repeated)) {
      throw new Error('Independent Git recovery did not prove the exact source and its required objects.');
    }
    const receipt: WorkspaceGitBundleReceipt = {
      schema: 'o8/workspace-git-bundle/v1', sha256: after.sha256, bytes: after.content.length,
      objectFormat: expected.objectFormat, repositoryUuid: snapshot.repositoryUuid, packetId: snapshot.packetId,
      snapshotGeneration: snapshot.snapshotGeneration, snapshotFingerprint: snapshot.snapshotFingerprint,
      headCommit: snapshot.headCommit, treeSha: snapshot.treeSha, recoveryRef: snapshot.recoveryRef,
      prerequisiteCount: 0, commitCount: expected.commitCount, objectCount: expected.objectCount,
    };
    await executePreservationBankOperation(bank, { operation: 'publish', leaf, identity, sha256: receipt.sha256, bytes: receipt.bytes,
      file: { device: after.stat.dev, inode: after.stat.ino } });
    await readWorkspaceGitBundle(receipt);
    return receipt;
  } finally {
    // Unknown writer closure retains staging; removing a name cannot settle a writer.
    if (writerAttempts.getStore()?.settlements.every(value => value.settled)) {
      await executePreservationBankOperation(bank, { operation: 'remove', leaf, identity });
    }
  }
}

export function preservationGitValue(...args: Parameters<typeof preservationGitValueNative>): ReturnType<typeof preservationGitValueNative> {
  return timeClosePhase('preservationGitValue', () => preservationGitValueNative(...args));
}

export function capturePreservationGitBundle(...args: Parameters<typeof capturePreservationGitBundleNative>): ReturnType<typeof capturePreservationGitBundleNative> {
  return timeClosePhase('capturePreservationGitBundle', () => capturePreservationGitBundleNative(...args));
}

export function preserveWorkspaceGitBundle(...args: Parameters<typeof preserveWorkspaceGitBundleNative>): ReturnType<typeof preserveWorkspaceGitBundleNative> {
  return timeClosePhase('preserveWorkspaceGitBundle', () => preserveWorkspaceGitBundleNative(...args));
}
