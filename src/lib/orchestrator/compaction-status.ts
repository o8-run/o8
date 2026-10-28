/** Lifecycle receipts, distinct from transcript boundaries and turn activity. */
export type CompactionPhase = 'waiting' | 'compacting' | 'complete' | 'failed' | 'cancelled' | 'uncertain';
export interface CompactionOperation {
  operationId: string;
  repoPath: string;
  threadId: string;
  phase: CompactionPhase;
  requestedAt: number;
  startedAt?: number;
  settledAt?: number;
  updatedAt: number;
  /** Only a runtime's measured work may populate this field. */
  progress?: { completed: number; total: number };
}
export const COMPACTION_UNVERIFIED_MS = 45_000;
export const COMPACTION_TERMINAL_DISPLAY_MS = 6_000;
export function isCompactionTerminal(phase: CompactionPhase): boolean {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled';
}
export function isCompactionOperation(value: unknown): value is CompactionOperation {
  if (!value || typeof value !== 'object') return false;
  const op = value as CompactionOperation;
  return typeof op.operationId === 'string' && typeof op.repoPath === 'string' && typeof op.threadId === 'string'
    && ['waiting', 'compacting', 'complete', 'failed', 'cancelled', 'uncertain'].includes(op.phase)
    && Number.isFinite(op.requestedAt) && Number.isFinite(op.updatedAt)
    && (op.startedAt === undefined || Number.isFinite(op.startedAt))
    && (op.settledAt === undefined || Number.isFinite(op.settledAt));
}
