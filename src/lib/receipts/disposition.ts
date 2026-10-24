import type { OrchestratorReleaseStatePayload } from '@/lib/orchestrator/types';
import {
  isCloseUnmergedDisposition,
  type CloseUnmergedDisposition,
} from '@/lib/orchestrator/close-unmerged-shared';
import type { PacketDisposition } from './types';

export const PACKET_DISPOSITION_EVENT_CODE = 'packet_disposition';

export function buildMergedPacketDisposition(input: {
  releaseStatePayload: OrchestratorReleaseStatePayload | null | undefined;
  tree: string;
  expectedMergeCommit?: string | null;
}): Extract<PacketDisposition, { kind: 'merged' }> {
  const payload = input.releaseStatePayload;
  const mergeCommit = payload?.mergeCommit?.trim() ?? '';
  const releasedAt = payload?.releasedAt?.trim() ?? '';
  const tree = input.tree.trim();
  if (!mergeCommit || !releasedAt || !tree) {
    throw new Error('Merged packet receipt requires persisted mergeCommit, releasedAt, and tree evidence.');
  }
  const expected = input.expectedMergeCommit?.trim();
  if (expected && expected !== mergeCommit) {
    throw new Error(`Persisted release evidence ${mergeCommit} does not match merge result ${expected}.`);
  }
  return {
    kind: 'merged',
    mergeCommit,
    headSha: payload?.headSha?.trim() || null,
    tree,
    evidenceKind: payload?.evidenceKind?.trim() || null,
    releasedAt,
  };
}

export function buildDiscardedPacketDisposition(input: {
  disposition: CloseUnmergedDisposition;
  reason?: string | null;
  preservedBranches?: string[];
  closedAt: string;
}): Extract<PacketDisposition, { kind: 'discarded' }> {
  if (!isCloseUnmergedDisposition(input.disposition)) {
    throw new Error('Discarded packet receipt has an invalid disposition.');
  }
  const closedAt = input.closedAt.trim();
  if (!closedAt) throw new Error('Discarded packet receipt requires closedAt.');
  return {
    kind: 'discarded',
    disposition: input.disposition,
    reason: input.reason?.trim() || '',
    preservedBranches: [...new Set((input.preservedBranches ?? []).map((branch) => branch.trim()).filter(Boolean))],
    closedAt,
  };
}

export function parsePacketDisposition(value: unknown): PacketDisposition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'pr_opened') {
    if (typeof record.branch !== 'string' || typeof record.commit !== 'string'
      || typeof record.prNumber !== 'number' || !Number.isInteger(record.prNumber) || record.prNumber < 1
      || !Array.isArray(record.verification) || !record.verification.every(item => typeof item === 'string')
      || typeof record.openedAt !== 'string') return null;
    return { kind: 'pr_opened', branch: record.branch, commit: record.commit, prNumber: record.prNumber,
      verification: record.verification, openedAt: record.openedAt };
  }
  if (record.kind === 'merged') {
    if (
      typeof record.mergeCommit !== 'string'
      || typeof record.tree !== 'string'
      || typeof record.releasedAt !== 'string'
      || (record.headSha !== null && typeof record.headSha !== 'string')
      || (record.evidenceKind !== null && typeof record.evidenceKind !== 'string')
    ) return null;
    return {
      kind: 'merged',
      mergeCommit: record.mergeCommit,
      headSha: record.headSha,
      tree: record.tree,
      evidenceKind: record.evidenceKind,
      releasedAt: record.releasedAt,
    };
  }
  if (
    record.kind !== 'discarded'
    || !isCloseUnmergedDisposition(record.disposition)
    || typeof record.reason !== 'string'
    || !Array.isArray(record.preservedBranches)
    || !record.preservedBranches.every((branch) => typeof branch === 'string')
    || typeof record.closedAt !== 'string'
  ) return null;
  return {
    kind: 'discarded',
    disposition: record.disposition,
    reason: record.reason,
    preservedBranches: record.preservedBranches,
    closedAt: record.closedAt,
  };
}
