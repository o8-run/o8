import { createHash } from 'node:crypto';
import path from 'node:path';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { captureExactDirectoryManifest, type ExactDirectoryManifestEntry } from '@/lib/workspace/exact-directory-purge';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from './materialization-identity';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from './materialization-execution';
import { readPinnedWorkspaceFileReceipt } from './materialization-leaf-io';

export interface WarmPacketSeal {
  workspace: string;
  movedWorkspace: string;
  administration: string;
  stableAdministration: string;
  adminIdentity: WorktreeMaterializationIdentity;
  head: string;
  branch: string;
  headMode: number;
  gitdirMode: number;
  logMode: number;
  logSize: number;
  logHash: string;
}

function digest(entries: ExactDirectoryManifestEntry[], moved = false): string {
  const normalized = entries.map(entry => {
    if (entry.kind === 'directory') return [entry.relative, entry.device, entry.inode, entry.kind, entry.mode];
    const pointer = moved && entry.relative === '.git' && entry.kind === 'file';
    return [entry.relative, entry.device, pointer ? null : entry.inode, entry.kind, entry.mode, entry.linkCount,
      entry.size, pointer ? null : entry.mtimeMs, pointer ? null : entry.ctimeMs, entry.contentSha256, entry.symlinkTarget];
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function inventory(workspace: string, identity: WorktreeMaterializationIdentity): Promise<ExactDirectoryManifestEntry[]> {
  await assertWorktreeMaterializationIdentity(workspace, identity);
  const manifest = await captureExactDirectoryManifest(workspace, identity, { contents: true });
  const links = new Map<string, { names: number; links: number }>();
  const byPath = new Map(manifest.entries.map(entry => [entry.relative, entry]));
  for (const entry of manifest.entries) {
    if (entry.device !== identity.device || entry.kind === 'other') throw new Error('Warm inventory crossed a filesystem or contains unsupported content.');
    if (entry.kind === 'file') {
      if (!entry.contentSha256) throw new Error('Warm inventory has no file content proof.');
      const key = `${entry.device}:${entry.inode}`;
      const group = links.get(key) ?? { names: 0, links: entry.linkCount };
      group.names += 1;
      group.links = Math.max(group.links, entry.linkCount);
      links.set(key, group);
    } else if (entry.kind === 'symlink') {
      if (!entry.symlinkTarget || path.isAbsolute(entry.symlinkTarget)) throw new Error('Warm inventory contains a non-relocatable link.');
      const resolved: string[] = [];
      const pending = entry.relative.split(path.sep);
      let expansions = 0;
      while (pending.length) {
        const part = pending.shift()!;
        if (!part || part === '.') continue;
        if (part === '..') {
          if (!resolved.length) throw new Error('Warm inventory contains an escaping symlink.');
          resolved.pop();
          continue;
        }
        const next = byPath.get([...resolved, part].join(path.sep));
        if (!next) throw new Error('Warm inventory contains an unresolved symlink.');
        if (next.kind === 'symlink') {
          if (++expansions > 40 || !next.symlinkTarget || path.isAbsolute(next.symlinkTarget)) throw new Error('Warm inventory contains a cyclic or escaping symlink.');
          pending.unshift(...next.symlinkTarget.split(path.sep));
        } else {
          if (pending.length && next.kind !== 'directory') throw new Error('Warm symlink traverses a non-directory.');
          resolved.push(part);
        }
      }
    }
  }
  if ([...links.values()].some(group => group.names !== group.links)) throw new Error('Warm inventory contains externally shared file bytes.');
  return manifest.entries;
}

async function git(workspace: string, identity: WorktreeMaterializationIdentity, args: string[]): Promise<string> {
  return withWorktreeMaterializationExecution(workspace, identity, async () => (await materializationAwareExecFile('git', args, {
    cwd: workspace, env: childEnvironment({ env: { GIT_OPTIONAL_LOCKS: '0' } }), timeout: 10_000, windowsHide: true,
  })).stdout.trim());
}

const stableAdmin = (entries: ExactDirectoryManifestEntry[]) => entries.filter(entry => !['HEAD', 'gitdir', 'logs/HEAD'].includes(entry.relative));

export async function captureWarmPacketSeal(repoRoot: string, workspace: string, identity: WorktreeMaterializationIdentity, head: string, branch: string): Promise<WarmPacketSeal> {
  const entries = await inventory(workspace, identity);
  if (entries.find(entry => entry.relative === '.git')?.kind !== 'file') throw new Error('Warm pool requires a linked Git worktree, not a private Git clone.');
  if (await git(workspace, identity, ['rev-parse', '--verify', 'HEAD^{commit}']) !== head
    || await git(workspace, identity, ['branch', '--show-current']) !== branch
    || await git(workspace, identity, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Warm Git source changed during preparation.');
  const admin = await git(workspace, identity, ['rev-parse', '--absolute-git-dir']);
  const repoIdentity = await captureWorktreeMaterializationIdentity(repoRoot);
  const common = await git(repoRoot, repoIdentity, ['rev-parse', '--git-common-dir']);
  if (!admin.startsWith(path.resolve(repoRoot, common, 'worktrees') + path.sep)) throw new Error('Warm Git administration escaped the repository.');
  const adminIdentity = await captureWorktreeMaterializationIdentity(admin);
  const administration = await inventory(admin, adminIdentity);
  const headEntry = administration.find(entry => entry.relative === 'HEAD');
  const gitdirEntry = administration.find(entry => entry.relative === 'gitdir');
  const logEntry = administration.find(entry => entry.relative === 'logs/HEAD');
  if (![headEntry, gitdirEntry, logEntry].every(entry => entry?.kind === 'file' && entry.linkCount === 1 && entry.contentSha256)) {
    throw new Error('Warm Git administration has no exact control-file proof.');
  }
  return { workspace: digest(entries), movedWorkspace: digest(entries, true), administration: digest(administration),
    stableAdministration: digest(stableAdmin(administration)), adminIdentity, head, branch,
    headMode: headEntry!.mode, gitdirMode: gitdirEntry!.mode, logMode: logEntry!.mode, logSize: logEntry!.size, logHash: logEntry!.contentSha256! };
}

export async function assertWarmPacketSeal(workspace: string, identity: WorktreeMaterializationIdentity, seal: WarmPacketSeal | undefined, moved = false, expectedBranch?: string): Promise<void> {
  if (!seal || !/^[a-f0-9]{64}$/.test(seal.workspace)) throw new Error('Unsealed warm workspace must remain retained.');
  const entries = await inventory(workspace, identity);
  if (digest(entries, moved) !== (moved ? seal.movedWorkspace : seal.workspace)) throw new Error('Warm workspace contents changed; retaining the tree.');
  const administration = await inventory(seal.adminIdentity.canonicalPath, seal.adminIdentity);
  if ((moved ? digest(stableAdmin(administration)) : digest(administration)) !== (moved ? seal.stableAdministration : seal.administration)) {
    throw new Error('Warm Git administration changed; retaining the tree.');
  }
  if (!moved && (await git(seal.adminIdentity.canonicalPath, seal.adminIdentity, ['--git-dir=.', `--work-tree=${workspace}`, 'rev-parse', '--verify', 'HEAD^{commit}']) !== seal.head
    || await git(seal.adminIdentity.canonicalPath, seal.adminIdentity, ['--git-dir=.', `--work-tree=${workspace}`, 'branch', '--show-current']) !== seal.branch)) {
    throw new Error('Warm branch or HEAD changed; retaining the tree.');
  }
  if (moved) {
    if (!expectedBranch) throw new Error('Moved warm Git ownership has no expected packet branch.');
    for (const [relative, mode, content] of [
      ['HEAD', seal.headMode, `ref: refs/heads/${expectedBranch}\n`],
      ['gitdir', seal.gitdirMode, path.join(workspace, '.git') + '\n'],
    ] as const) {
      const entry = administration.find(entry => entry.relative === relative);
      if (entry?.kind !== 'file' || entry.linkCount !== 1 || entry.mode !== mode
        || entry.contentSha256 !== createHash('sha256').update(content).digest('hex')) throw new Error('Moved warm Git binding changed.');
    }
    const logEntry = administration.find(entry => entry.relative === 'logs/HEAD');
    if (logEntry?.kind !== 'file' || logEntry.linkCount !== 1 || logEntry.mode !== seal.logMode) throw new Error('Moved warm Git log changed identity.');
    const receipt = await readPinnedWorkspaceFileReceipt(seal.adminIdentity.canonicalPath, seal.adminIdentity, 'logs/HEAD');
    const bytes = Buffer.from(receipt?.content ?? '');
    if (receipt?.inode !== logEntry.inode || receipt.device !== logEntry.device
      || createHash('sha256').update(bytes).digest('hex') !== logEntry.contentSha256) throw new Error('Moved warm Git log changed after capture.');
    const prefix = bytes.subarray(0, seal.logSize);
    const appended = bytes.subarray(seal.logSize).toString().trimEnd().split('\n');
    const fields = appended.map(line => line.split('\t'));
    const transitions = fields.map(parts => parts[0].split(' ').slice(0, 2).join(' '));
    const zero = '0'.repeat(seal.head.length);
    const knownTransition = transitions.length === 1 && transitions[0] === `${seal.head} ${seal.head}`
      || transitions.length === 2 && transitions[0] === `${seal.head} ${zero}` && transitions[1] === `${zero} ${seal.head}`;
    if (createHash('sha256').update(prefix).digest('hex') !== seal.logHash || !knownTransition
      || fields.some(parts => parts.length !== 2 || parts[1] !== `Branch: renamed refs/heads/${seal.branch} to refs/heads/${expectedBranch}`)) {
      throw new Error('Moved warm Git log contains unexpected history.');
    }
    if (await git(seal.adminIdentity.canonicalPath, seal.adminIdentity, ['--git-dir=.', `--work-tree=${workspace}`, 'rev-parse', '--verify', 'HEAD^{commit}']) !== seal.head
      || await git(seal.adminIdentity.canonicalPath, seal.adminIdentity, ['--git-dir=.', `--work-tree=${workspace}`, 'branch', '--show-current']) !== expectedBranch) {
      throw new Error('Moved warm Git branch or HEAD changed.');
    }
  }
}
