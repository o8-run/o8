import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { assertWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readPinnedWorkspaceFile, writePinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { captureExactDirectoryManifest } from './exact-directory-purge';
import type { DependencyInstallRecipe } from './dependency-install';

const RECEIPT = '.o8-dependency-payload.json';
export interface DependencyPayloadFingerprint {
  device: number;
  inode: number;
  contents: string;
}
export interface DependencyPayloadReceipt extends DependencyPayloadFingerprint {
  schema: 'o8/dependency-payload/v2';
  seal: string;
  recipe: string;
  graph: string;
}
export class DependencyPayloadRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}
const refuse = (reason: string): never => { throw new DependencyPayloadRefusal(reason); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function recipeKey(recipe: DependencyInstallRecipe): string {
  const { key: _key, cacheAuthorityId: _cache, gitTreeSha, ...inputs } = recipe;
  return digest({ inputs, ...(recipe.lifecycleScripts === 'enabled' && recipe.cloneLifecycleInputs === undefined ? { gitTreeSha } : {}) });
}

/** Full no-follow inventory; portable payload identity stays separate from inode ownership. */
async function inspectPayload(workspace: string, authority: WorktreeMaterializationIdentity, entrypoints: string[]): Promise<DependencyPayloadFingerprint> {
  await assertWorktreeMaterializationIdentity(workspace, authority);
  const root = path.join(workspace, 'node_modules');
  const captured = await lstat(root);
  if (!captured.isDirectory() || captured.isSymbolicLink()) return refuse('payload-root-invalid');
  const inventory = await captureExactDirectoryManifest(root, { device: captured.dev, inode: captured.ino }, { contents: true });
  const { entries } = inventory;
  if (entries.length > 500_000) return refuse('payload-inventory-limit');
  const byPath = new Map(entries.map(entry => [entry.relative, entry]));
  const portable = createHash('sha256');
  const links = new Map<string, { names: number; count: number }>();
  const resolve = (relative: string): string => {
    const pending = relative.split(path.sep);
    const resolved: string[] = [];
    let expansions = 0;
    while (pending.length) {
      const segment = pending.shift()!;
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (!resolved.length) return refuse('payload-escaping-link');
        resolved.pop(); continue;
      }
      const next = byPath.get([...resolved, segment].join(path.sep));
      if (!next) return refuse('payload-unresolved-link');
      if (next.kind === 'symlink') {
        if (!next.symlinkTarget || path.isAbsolute(next.symlinkTarget)) return refuse('payload-absolute-link');
        if (++expansions > 40) return refuse('payload-cyclic-link');
        pending.unshift(...next.symlinkTarget.split(path.sep));
      } else {
        if (pending.length && next.kind !== 'directory') return refuse('payload-unresolved-link');
        resolved.push(segment);
      }
    }
    return resolved.join(path.sep);
  };
  for (const entry of entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)) {
    if (entry.device !== captured.dev || entry.kind === 'other') return refuse('payload-unsupported-entry');
    if (entry.relative === RECEIPT) {
      if (entry.kind !== 'file' || entry.linkCount !== 1 || entry.size > 4096) return refuse('payload-receipt-invalid');
      continue;
    }
    if (entry.kind === 'file') {
      const key = `${entry.device}:${entry.inode}`;
      const group = links.get(key) ?? { names: 0, count: entry.linkCount };
      group.names++; group.count = Math.max(group.count, entry.linkCount); links.set(key, group);
    }
    if (entry.kind === 'symlink') {
      resolve(entry.relative);
    }
    if (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.contentSha256 ?? '')) return refuse('payload-unreadable');
    // APFS directory link counts and inode/timestamp metadata are not content.
    // Hash every payload file, including hidden data outside declared entrypoints.
    portable.update(JSON.stringify([entry.relative, entry.kind, entry.mode & 0o7777,
      entry.contentSha256 ?? null, entry.symlinkTarget ?? null]));
  }
  // Link counts are an isolation guard for regular files, never the seal.
  if ([...links.values()].some(group => group.names !== group.count)) return refuse('payload-shared-hardlink');
  for (const relative of [...new Set(entrypoints)].sort()) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) return refuse('payload-entrypoint-invalid');
    if (!byPath.has(relative) || byPath.get(resolve(relative))?.kind !== 'file') return refuse('payload-entrypoint-missing');
  }
  const final = await lstat(root);
  if (!final.isDirectory() || final.isSymbolicLink() || final.dev !== captured.dev || final.ino !== captured.ino) return refuse('payload-root-invalid');
  // No writes occur during inspection. Recheck every ancestor and leaf,
  // including root/receipt stamps, before accepting any path-based reads.
  const stable = await captureExactDirectoryManifest(root, { device: captured.dev, inode: captured.ino }, { contents: true });
  if (stable.fingerprint !== inventory.fingerprint) return refuse('payload-changed');
  await assertWorktreeMaterializationIdentity(workspace, authority);
  return { device: final.dev, inode: final.ino, contents: portable.digest('hex') };
}

export async function inspectDependencyPayload(workspace: string, authority: WorktreeMaterializationIdentity, entrypoints: string[] = []): Promise<DependencyPayloadFingerprint> {
  try { return await inspectPayload(workspace, authority, entrypoints); }
  catch (error) {
    if (error instanceof DependencyPayloadRefusal) throw error;
    await assertWorktreeMaterializationIdentity(workspace, authority);
    throw new DependencyPayloadRefusal('payload-unreadable');
  }
}

async function readReceipt(workspace: string, authority: WorktreeMaterializationIdentity, recipe: DependencyInstallRecipe, graph: { digest: string; entrypoints: string[] }, expected?: DependencyPayloadReceipt): Promise<DependencyPayloadReceipt> {
  const observed = await inspectDependencyPayload(workspace, authority, graph.entrypoints);
  const bytes = await readPinnedWorkspaceFile(workspace, authority, `node_modules/${RECEIPT}`);
  if (!bytes || Buffer.byteLength(bytes) > 4096) return refuse('payload-unsealed');
  let receipt: DependencyPayloadReceipt;
  try { receipt = JSON.parse(bytes) as DependencyPayloadReceipt; }
  catch { return refuse('payload-receipt-invalid'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schema !== 'o8/dependency-payload/v2' || receipt.recipe !== recipeKey(recipe) || receipt.graph !== graph.digest
    || !['contents', 'seal'].every(key => /^[a-f0-9]{64}$/.test(receipt[key as 'contents' | 'seal']))
    || receipt.seal !== digest([graph.digest, receipt.contents])) return refuse('payload-receipt-invalid');
  if (expected && JSON.stringify(receipt) !== JSON.stringify(expected)) return refuse('payload-changed');
  if (receipt.device !== observed.device || receipt.inode !== observed.inode
    || receipt.contents !== observed.contents) return refuse('payload-changed');
  return receipt;
}

export async function readDependencyPayloadReceipt(workspace: string, authority: WorktreeMaterializationIdentity, recipe: DependencyInstallRecipe, graph: { digest: string; entrypoints: string[] }, expected?: DependencyPayloadReceipt): Promise<DependencyPayloadReceipt> {
  try { return await readReceipt(workspace, authority, recipe, graph, expected); }
  catch (error) {
    if (error instanceof DependencyPayloadRefusal) throw error;
    await assertWorktreeMaterializationIdentity(workspace, authority);
    throw new DependencyPayloadRefusal('payload-unreadable');
  }
}

/** Only completed installation or verified exact clone publication may establish a new baseline. */
export async function sealDependencyPayload(workspace: string, authority: WorktreeMaterializationIdentity, recipe: DependencyInstallRecipe, graph: { digest: string; entrypoints: string[] }, observed?: DependencyPayloadFingerprint, expectedRoot?: { device: number; inode: number }): Promise<DependencyPayloadReceipt> {
  const before = observed ?? await inspectDependencyPayload(workspace, authority, graph.entrypoints);
  if (expectedRoot && (before.device !== expectedRoot.device || before.inode !== expectedRoot.inode)) throw new Error('Dependency clone payload ownership changed.');
  const root = path.join(workspace, 'node_modules');
  const payloadAuthority = { canonicalPath: path.join(authority.canonicalPath, 'node_modules'), device: before.device, inode: before.inode };
  await assertWorktreeMaterializationIdentity(workspace, authority);
  await assertWorktreeMaterializationIdentity(root, payloadAuthority);
  const receipt: DependencyPayloadReceipt = { schema: 'o8/dependency-payload/v2', recipe: recipeKey(recipe), graph: graph.digest, seal: digest([graph.digest, before.contents]), ...before };
  await writePinnedWorkspaceFile(root, payloadAuthority, RECEIPT, JSON.stringify(receipt));
  const after = await inspectDependencyPayload(workspace, authority, graph.entrypoints);
  if (JSON.stringify(before) !== JSON.stringify(after)) return refuse('payload-changed');
  return receipt;
}
