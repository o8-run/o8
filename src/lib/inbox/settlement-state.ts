/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * apps/server/src/orchestration-v2/Orchestrator.ts and
 * packages/client-runtime/src/state/threadSettled.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: shared TypeScript transitions and normalized execution evidence.
 */
export interface InboxSubject {
  kind: 'conversation' | 'runtime';
  id: string;
  workspace: string | null;
  projectId: string | null;
}
export interface InboxSettlement {
  settledOverride: null | 'settled' | 'active';
  settledAt: string | null;
  unsettledAt: string | null;
}
export const emptySettlement = (): InboxSettlement => ({ settledOverride: null, settledAt: null, unsettledAt: null });

export function transitionSettlement(state: InboxSettlement, action: 'settle' | 'unsettle' | 'run', now: string): InboxSettlement {
  if (action === 'settle') return {
    settledOverride: 'settled',
    settledAt: state.settledOverride === 'settled' && state.settledAt !== null ? state.settledAt : now,
    unsettledAt: null,
  };
  if (action === 'unsettle') return {
    settledOverride: 'active', settledAt: null,
    unsettledAt: state.settledOverride === 'active' ? state.unsettledAt : now,
  };
  return {
    settledOverride: null, settledAt: null,
    unsettledAt: state.settledOverride === 'settled' ? now : state.unsettledAt,
  };
}

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
export function hasQueuedTurnStart(input: {
  status?: string; latestUserMessageAt?: number; latestRunAt?: number; failed?: boolean;
}, now: number): boolean {
  if (['preparing', 'queued', 'starting', 'launching'].includes(input.status ?? '')) return true;
  if (input.failed || input.latestUserMessageAt === undefined) return false;
  if (!Number.isFinite(input.latestUserMessageAt) || !Number.isFinite(now)) return false;
  if (Math.abs(now - input.latestUserMessageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  return input.latestRunAt === undefined || input.latestRunAt < input.latestUserMessageAt;
}
