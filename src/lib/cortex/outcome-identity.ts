import { createHash } from 'node:crypto';

export interface OutcomeMemoryIdentity {
  projectId?: string | null;
  repoPath: string;
  packetId?: string | null;
  sessionKey?: string | null;
  summary?: string | null;
}

/** Match content within its project/repository scope, independently of capture provenance. */
export function outcomeMemoryFingerprint(value: OutcomeMemoryIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    value.projectId ?? null, value.repoPath,
    (value.summary || '(no summary)').slice(0, 4000),
  ])).digest('hex');
}
