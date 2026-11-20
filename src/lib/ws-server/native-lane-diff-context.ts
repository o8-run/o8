import type { NextRequest } from 'next/server';
import { lstatSync } from 'node:fs';
import { requirePanelOrWorkerAuth } from '@/lib/auth/packet-worker-auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getLane, findLatestLaneByPacket } from '@/lib/lane/registry';
import { resolveLaneReviewSource } from '@/lib/lane/review-source';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { resolvePacketDiffBaseTarget } from '@/lib/diff/base-resolution';
import { laneGitArguments, laneGitInvocationAsync } from '@/lib/lane/lane-git';

/** Request-scoped authority only. Never calls the diff producer or copies its output. */
export async function nativeLaneDiffTarget(request: NextRequest, id: string) {
  if (requirePanelOrWorkerAuth(request)) return null;
  const lane = getLane(id) ?? findLatestLaneByPacket(id);
  if (!lane || workerPacketRefusal(resolveRequestPrincipalContext(request), lane.packetId)) return null;
  try {
    const source = await resolveLaneReviewSource(lane);
    if (source.kind !== 'materialized') return null;
    // Keep the host's canonical metadata validation, but pass only directory
    // identities. No environment or arbitrary executable arguments cross over.
    const invocation = await laneGitInvocationAsync(source.cwd, lane.repoPath, ['diff']);
    if (JSON.stringify(invocation.args) !== JSON.stringify(laneGitArguments(['diff']))) return null;
    const directory = (path: string | undefined) => {
      if (!path) throw new Error('Missing Git directory');
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Git directory');
      return { path, dev: String(stat.dev), ino: String(stat.ino) };
    };
    // Git's stat summary is localized. The daemon's clean environment uses
    // English/C output; defer other locales rather than change that response.
    if (Object.entries(invocation.env).some(([key, value]) => (key === 'LANG' || key === 'LANGUAGE' || key.startsWith('LC_'))
      && value && !/^(?:C(?:\.(?:UTF-?8))?|POSIX|en(?:[_-][A-Za-z]{2})?(?:\.[A-Za-z0-9-]+)?)$/i.test(value))) return null;
    const creationBase = readLaneCreationBaseCommit(lane.id);
    const baseBranch = lane.baseBranch || 'main';
    const baseTarget = creationBase ? { kind: 'creation' as const, ref: creationBase }
      : { kind: 'legacy' as const, ...(await resolvePacketDiffBaseTarget(source.cwd, baseBranch)) };
    return { version: 1, requestId: id, laneId: lane.id, packetId: lane.packetId ?? null, ...source,
      base: baseBranch.trim(), baseTarget,
      home: invocation.env.HOME ?? null, configHome: invocation.env.XDG_CONFIG_HOME ?? null,
      worktree: directory(invocation.env.GIT_WORK_TREE), admin: directory(invocation.env.GIT_DIR), common: directory(invocation.env.GIT_COMMON_DIR) };
  } catch { return null; }
}
