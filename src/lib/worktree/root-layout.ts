import { createHash } from 'node:crypto';
import { spawn } from '@/lib/providers/child-process';
import { once } from 'node:events';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { observeStorageVolume } from '@/lib/workspace/storage-admission';
import type { StorageRootIdentity } from '@/lib/workspace/storage-admission';
import { ensurePinnedWorkspaceDirectory } from './materialization-leaf-io';
import { guardedWorkspaceInvocation } from './materialization-execution';

export const LEGACY_WORKTREE_DIR_NAME = '.cortex-worktrees';
export const WORKTREE_ROOT_ENV = 'O8_WORKTREE_ROOT';
// Keep the legacy packet-id + hyphen prefix used by conservative recovery scans.
export const WORKTREE_INDEX_EXCLUSION_SUFFIX = '-index.noindex';
const WORKTREE_COLLISION_SUFFIX_RE = /^[a-z0-9]{4}$/;

/** Stable directory prefix shared by materialization, cleanup, and reconciliation. */
export function managedPacketWorktreeId(packetId: string): string | null {
  const slug = packetId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug ? `packet-${slug}` : null;
}

/**
 * Syntactic prefilter for a packet's manager-owned slot. Collision retries add
 * exactly four lowercase base-36 characters; the metadata identity receipt
 * must still prove that WorktreeManager created the candidate directory.
 */
export function isManagedPacketWorktreeId(candidateId: string, packetId: string): boolean {
  const baseId = managedPacketWorktreeId(packetId);
  if (!baseId) return false;
  const id = candidateId.endsWith(WORKTREE_INDEX_EXCLUSION_SUFFIX)
    ? candidateId.slice(0, -WORKTREE_INDEX_EXCLUSION_SUFFIX.length) : candidateId;
  if (id === baseId) return true;
  if (!id.startsWith(`${baseId}-`)) return false;
  return WORKTREE_COLLISION_SUFFIX_RE.test(id.slice(baseId.length + 1));
}

/** Keep collision generation and recognition on one naming invariant. */
export function appendWorktreeCollisionSuffix(baseId: string): string {
  let suffix = '';
  while (!WORKTREE_COLLISION_SUFFIX_RE.test(suffix)) {
    suffix = Math.random().toString(36).slice(2, 6);
  }
  const excluded = baseId.endsWith(WORKTREE_INDEX_EXCLUSION_SUFFIX);
  const stem = excluded ? baseId.slice(0, -WORKTREE_INDEX_EXCLUSION_SUFFIX.length) : baseId;
  return `${stem}-${suffix}${excluded ? WORKTREE_INDEX_EXCLUSION_SUFFIX : ''}`;
}

export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync.native(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

/** Resolve a workspace namespace through surviving ancestors without creating it. */
export function canonicalWorktreeNamespace(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  let ancestor = path.dirname(resolved);
  const suffix = [path.basename(resolved)];
  for (;;) {
    try {
      return path.join(realpathSync.native(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Stable, human-readable key that prevents same-named repos from colliding. */
export function worktreeRepoKey(repoRoot: string): string {
  const canonical = canonicalRepoRoot(repoRoot);
  const label = path.basename(canonical)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48) || 'repo';
  const identity = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${label}-${identity}`;
}

export interface WorktreeRootLayout {
  configuredRoot: string;
  primaryBase: string;
  legacyBase: string;
  bases: string[];
  repoKey: string;
}

interface ConfiguredRootReceipt {
  canonicalPath: string;
  device: number;
  inode: number;
}

export interface ExplicitRootCreationHooks {
  afterParentProof?: () => Promise<void>;
}

const PINNED_ROOT_CREATION_SCRIPT = String.raw`
const fs = require('node:fs');
const expected = JSON.parse(process.argv[1]);
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
function parentMatches() {
  const parent = fs.lstatSync('.');
  return parent.isDirectory() && !parent.isSymbolicLink()
    && parent.dev === expected.parent.device && parent.ino === expected.parent.inode
    && fs.realpathSync('.') === expected.parent.canonicalPath;
}
function retireCreated(created) {
  const named = fs.lstatSync(expected.name);
  if (!named.isDirectory() || named.isSymbolicLink()
    || named.dev !== created.device || named.ino !== created.inode
    || fs.readdirSync(expected.name).length !== 0) {
    throw new Error('Pinned root creation refused to retire an ambiguous leaf identity.');
  }
  fs.rmdirSync(expected.name);
  const parentFd = fs.openSync('.', fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
}
process.stdout.write(JSON.stringify({ phase: 'ready' }) + '\n');
if (readSignal() !== 'create') process.exit(0);
let created = null;
try {
  fs.mkdirSync(expected.name, { mode: expected.mode });
  const named = fs.lstatSync(expected.name);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error('Pinned root creation did not produce a real directory.');
  }
  created = { device: named.dev, inode: named.ino };
  const parentFd = fs.openSync('.', fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  process.stdout.write(JSON.stringify({ phase: 'created', ...created }) + '\n');
  const signal = readSignal();
  const rootCanonical = fs.realpathSync(expected.name);
  if (signal !== 'accept' || !parentMatches()
    || rootCanonical !== expected.canonicalPath) {
    retireCreated(created);
    process.stdout.write(JSON.stringify({ phase: 'retired', ...created }) + '\n');
    process.exit(78);
  }
  const repeated = fs.lstatSync(expected.name);
  if (!repeated.isDirectory() || repeated.isSymbolicLink()
    || repeated.dev !== created.device || repeated.ino !== created.inode) {
    throw new Error('Pinned root creation identity changed before acceptance.');
  }
  process.stdout.write(JSON.stringify({
    phase: 'accepted', ...created, canonicalPath: rootCanonical,
  }) + '\n');
} catch (error) {
  if (created) {
    try { retireCreated(created); } catch (retireError) {
      process.stderr.write(retireError.message + '\n');
      process.exit(79);
    }
  }
  process.stderr.write(error.message + '\n');
  process.exit(78);
}
`;

function captureExplicitParent(configuredRoot: string): ConfiguredRootReceipt {
  const parent = path.dirname(configuredRoot);
  let entry;
  try {
    entry = lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Explicit worktree root parent must already exist.');
    }
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Explicit worktree root parent must be a real directory.');
  }
  return {
    canonicalPath: realpathSync.native(parent),
    device: entry.dev,
    inode: entry.ino,
  };
}

function captureConfiguredRoot(configuredRoot: string, explicit: boolean): ConfiguredRootReceipt | null {
  let entry;
  try {
    entry = lstatSync(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(explicit
      ? 'Configured worktree root was replaced or is not a real directory.'
      : 'Configured worktree root must be a real directory.');
  }
  const canonicalPath = realpathSync.native(configuredRoot);
  const repeated = lstatSync(configuredRoot);
  if (repeated.isSymbolicLink() || !repeated.isDirectory()
    || repeated.dev !== entry.dev || repeated.ino !== entry.ino) {
    throw new Error('Configured worktree root identity changed during capture.');
  }
  return { canonicalPath, device: entry.dev, inode: entry.ino };
}

async function createPinnedExplicitRoot(
  configuredRoot: string,
  parent: ConfiguredRootReceipt,
  hooks: ExplicitRootCreationHooks,
): Promise<ConfiguredRootReceipt> {
  const parentPath = path.dirname(configuredRoot);
  const canonicalPath = path.join(parent.canonicalPath, path.basename(configuredRoot));
  const invocation = guardedWorkspaceInvocation(
    process.execPath,
    ['-e', PINNED_ROOT_CREATION_SCRIPT, JSON.stringify({
      parent,
      name: path.basename(configuredRoot),
      canonicalPath,
      mode: 0o777,
    })],
    parent,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: parentPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = once(child, 'close') as Promise<[number | null]>;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const waitForLine = async (index: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 10_000;
    while (stdout.split('\n').length - 1 <= index && child.exitCode === null) {
      if (Date.now() >= deadline) {
        child.kill('SIGTERM');
        throw new Error('Pinned root creation receipt timed out.');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const line = stdout.split('\n')[index];
    if (!line) {
      const [code] = await closed;
      throw new Error(stderr.trim() || `Pinned root creation exited ${code}.`);
    }
    return JSON.parse(line) as Record<string, unknown>;
  };
  let result: ConfiguredRootReceipt | null = null;
  let failure: unknown = null;
  try {
    const ready = await waitForLine(0);
    if (ready.phase !== 'ready') throw new Error('Pinned root creation did not prove its parent.');
    await hooks.afterParentProof?.();
    child.stdin.write('create\n');
    const created = await waitForLine(1);
    if (created.phase !== 'created'
      || !Number.isSafeInteger(created.device) || !Number.isSafeInteger(created.inode)) {
      throw new Error('Pinned root creation returned an invalid leaf receipt.');
    }
    const named = await lstat(configuredRoot).catch(() => null);
    const namedCanonical = named?.isDirectory() && !named.isSymbolicLink()
      ? await realpath(configuredRoot).catch(() => null)
      : null;
    const namedMatches = named !== null
      && namedCanonical === canonicalPath
      && named.dev === created.device && named.ino === created.inode;
    child.stdin.write(namedMatches ? 'accept\n' : 'retire\n');
    const settled = await waitForLine(2);
    if (!namedMatches || settled.phase !== 'accepted'
      || settled.canonicalPath !== canonicalPath
      || settled.device !== created.device || settled.inode !== created.inode) {
      throw new Error('Explicit worktree root parent changed during exact creation.');
    }
    result = {
      canonicalPath,
      device: Number(created.device),
      inode: Number(created.inode),
    };
  } catch (error) {
    failure = error;
  } finally {
    child.stdin.end();
  }
  const [code] = await closed;
  if (code !== 0 && code !== 78) {
    throw new Error(stderr.trim() || `Pinned root creation exited ${code}.`);
  }
  if (failure) {
    let currentParentMatches = false;
    try {
      const currentParent = lstatSync(parentPath);
      currentParentMatches = currentParent.isDirectory() && !currentParent.isSymbolicLink()
        && currentParent.dev === parent.device && currentParent.ino === parent.inode
        && realpathSync.native(parentPath) === parent.canonicalPath;
    } catch {
      currentParentMatches = false;
    }
    if (!currentParentMatches) {
      throw new Error('Explicit worktree root parent changed during exact creation.');
    }
    throw failure;
  }
  if (!result) throw new Error('Pinned root creation returned no accepted leaf receipt.');
  return result;
}

/**
 * Resolve the external worktree root for one repo while retaining the legacy
 * in-repo base as a read/cleanup compatibility location.
 */
export function resolveWorktreeRootLayout(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeRootLayout {
  const dataDir = getDataDir(env);
  const configuredRoot = path.resolve(env[WORKTREE_ROOT_ENV]?.trim() || path.join(dataDir, 'worktrees'));
  const repoKey = worktreeRepoKey(repoRoot);
  const primaryBase = path.join(configuredRoot, repoKey, LEGACY_WORKTREE_DIR_NAME);
  const legacyBase = path.join(path.resolve(repoRoot), LEGACY_WORKTREE_DIR_NAME);
  return {
    configuredRoot,
    primaryBase,
    legacyBase,
    bases: primaryBase === legacyBase ? [primaryBase] : [primaryBase, legacyBase],
    repoKey,
  };
}

/** Resolve the volume target used before a managed packet workspace exists.
 *  A read passes `create: false`: a missing default root is not created, and the
 *  target is its would-be path, whose volume is observed through the nearest
 *  existing ancestor. */
export function resolveManagedWorktreeStorageTarget(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { create?: boolean } = {},
): string {
  const layout = resolveWorktreeRootLayout(repoRoot, env);
  const explicit = Boolean(env[WORKTREE_ROOT_ENV]?.trim());
  if (!explicit && options.create !== false) mkdirSync(layout.configuredRoot, { recursive: true });
  const parent = explicit ? captureExplicitParent(layout.configuredRoot) : null;
  const configuredRoot = captureConfiguredRoot(layout.configuredRoot, explicit);
  if (!configuredRoot && !parent) return path.resolve(layout.primaryBase);
  const canonicalRoot = configuredRoot?.canonicalPath
    ?? path.join(parent!.canonicalPath, path.basename(layout.configuredRoot));
  return path.resolve(canonicalRoot, path.relative(layout.configuredRoot, layout.primaryBase));
}

export async function observeManagedWorktreeRootIdentity(
  repoRoot: string,
  hooks: ExplicitRootCreationHooks = {},
): Promise<StorageRootIdentity> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  const explicit = Boolean(process.env[WORKTREE_ROOT_ENV]?.trim());
  if (!explicit) mkdirSync(layout.configuredRoot, { recursive: true });
  const parent = explicit ? captureExplicitParent(layout.configuredRoot) : null;
  const captured = captureConfiguredRoot(layout.configuredRoot, explicit)
    ?? await createPinnedExplicitRoot(layout.configuredRoot, parent!, hooks);
  return {
    canonicalPath: captured.canonicalPath,
    device: String(captured.device),
    inode: String(captured.inode),
  };
}

/** Re-prove root containment and device identity immediately before worktree materialization. */
export async function assertManagedWorktreeMaterializationBoundary(
  repoRoot: string,
  expectedVolumeId: string,
  expectedRoot: StorageRootIdentity,
): Promise<StorageRootIdentity> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  const rootLink = await lstat(layout.configuredRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
    throw new Error('Configured worktree root was replaced after storage admission.');
  }
  const canonicalRoot = await realpath(layout.configuredRoot);
  const rootIdentity = await stat(canonicalRoot, { bigint: true });
  if (canonicalRoot !== expectedRoot.canonicalPath
    || rootIdentity.dev.toString() !== expectedRoot.device
    || rootIdentity.ino.toString() !== expectedRoot.inode) {
    throw new Error('Configured worktree root identity changed after storage admission.');
  }
  const relativeBase = path.relative(layout.configuredRoot, layout.primaryBase);
  if (!relativeBase || relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
    throw new Error('Managed worktree base is outside the configured worktree root.');
  }
  const pinnedBase = await ensurePinnedWorkspaceDirectory(layout.configuredRoot, {
    canonicalPath: canonicalRoot,
    device: Number(rootIdentity.dev),
    inode: Number(rootIdentity.ino),
  }, relativeBase.split(path.sep).join('/'));
  const observation = await observeStorageVolume(pinnedBase.canonicalPath);
  if (observation.status !== 'observed' || observation.volumeId !== expectedVolumeId) {
    throw new Error('Managed worktree volume changed after storage admission.');
  }
  if (pinnedBase.canonicalPath !== canonicalRoot
    && !pinnedBase.canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('Managed worktree base is not an exact directory under the admitted root.');
  }
  return {
    canonicalPath: pinnedBase.canonicalPath,
    device: pinnedBase.device.toString(),
    inode: pinnedBase.inode.toString(),
  };
}

/** Confirm the created workspace landed under the admitted root on the admitted device. */
export async function assertManagedWorktreeCreatedBoundary(
  repoRoot: string,
  createdPath: string,
  expectedVolumeId: string,
  expectedRoot: StorageRootIdentity,
  expectedBase: StorageRootIdentity,
): Promise<void> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  const rootLink = await lstat(layout.configuredRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
    throw new Error('Configured worktree root changed during materialization.');
  }
  const canonicalRoot = await realpath(layout.configuredRoot);
  const rootIdentity = await stat(canonicalRoot, { bigint: true });
  if (canonicalRoot !== expectedRoot.canonicalPath
    || rootIdentity.dev.toString() !== expectedRoot.device
    || rootIdentity.ino.toString() !== expectedRoot.inode) {
    throw new Error('Configured worktree root identity changed during materialization.');
  }
  const canonicalBase = await realpath(layout.primaryBase);
  const baseIdentity = await lstat(canonicalBase, { bigint: true });
  if (!baseIdentity.isDirectory() || baseIdentity.isSymbolicLink()
    || canonicalBase !== expectedBase.canonicalPath
    || baseIdentity.dev.toString() !== expectedBase.device
    || baseIdentity.ino.toString() !== expectedBase.inode) {
    throw new Error('Managed worktree base identity changed during materialization.');
  }
  const identity = await lstat(createdPath);
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('Created managed worktree is redirected or is not a directory.');
  }
  const canonicalCreated = await realpath(createdPath);
  if (!canonicalCreated.startsWith(`${canonicalBase}${path.sep}`)) {
    throw new Error('Created managed worktree resolves outside the admitted repository namespace.');
  }
  const observation = await observeStorageVolume(canonicalCreated);
  if (observation.status !== 'observed' || observation.volumeId !== expectedVolumeId) {
    throw new Error('Created managed worktree is not on the admitted volume.');
  }
}
