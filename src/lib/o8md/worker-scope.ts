import { realpathSync } from 'node:fs';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { findLaneByPacket } from '@/lib/lane/registry';

export type SpecCaller = { worker: false } | { worker: true; repoPath: string | null };

export const WORKER_SPEC_SCOPE_REFUSAL = {
  code: 'worker_packet_mismatch',
  message: "A worker reads and annotates only its own lane's o8.md.",
} as const;

function realPathOrNull(path: string | null | undefined): string | null {
  if (!path) return null;
  try { return realpathSync(path); } catch { return null; }
}

/**
 * The gate lets a packet worker read and annotate o8.md and its assets. A worker reaches only its
 * active lane's worktree or repository: its repoPath is that directory's real path, which the
 * caller uses for the rest of the request, or null for any other directory. Other callers are
 * not workers and keep the path they sent.
 */
export function specCallerScope(request: Request, repoPath: string): SpecCaller {
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'worker') return { worker: false };
  const lane = principal.packetId ? findLaneByPacket(principal.packetId) : null;
  const target = realPathOrNull(repoPath);
  const own = target !== null && [lane?.worktreePath, lane?.repoPath].some((dir) => realPathOrNull(dir) === target);
  return { worker: true, repoPath: own ? target : null };
}
