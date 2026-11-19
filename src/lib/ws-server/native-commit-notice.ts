import type { RealtimeMutationPublishRequest } from '@/lib/realtime/types';
const ACTIONS = new Set(['prompt-library.create', 'prompt-library.edit', 'prompt-library.use', 'prompt-library.delete', 'session-rule.add', 'session-rule.remove']);
/** Narrow metadata only, on the already-authenticated owner/producer socket. */
export function nativeCommitNotice(value: unknown, epoch: string): RealtimeMutationPublishRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || v.version !== 1 || v.kind !== 'native-commit' || v.epoch !== epoch) return null;
  const r = v.request as RealtimeMutationPublishRequest | undefined;
  if (!r || Object.keys(r).length !== 3 || r.kind !== 'mutation' || !Array.isArray(r.refreshTargets)
    || r.refreshTargets.length !== 1 || r.refreshTargets[0] !== 'global') return null;
  const m = r.mutation;
  if (!m || typeof m !== 'object' || m.status !== 'completed') return null;
  if (m.action === 'composer-queue') {
    if (Object.keys(m).length !== 7 || m.source !== 'desktop' || typeof m.repoPath !== 'string'
      || !m.repoPath.startsWith('/') || Buffer.byteLength(m.repoPath) > 4096) return null;
  } else if (Object.keys(m).length !== 6 || m.source !== 'server' || !ACTIONS.has(m.action)) return null;
  if (![m.mutationId, m.surfaceId, m.createdAt].every(s => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 4096)) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.createdAt) || !Number.isFinite(Date.parse(m.createdAt))) return null;
  return r;
}
