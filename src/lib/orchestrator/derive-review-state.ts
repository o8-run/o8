/**
 * Pure state derivation for #621 — o8_review_state MCP tool.
 *
 * Collapses (packet, lane, orchestrator review, merge gate) into a single
 * deterministic state label an MCP-driving agent can poll for.
 *
 * No I/O. Do not add filesystem, network, or registry calls here — callers
 * (the API route, UI, tests) pass in already-loaded state.
 */
import type { Lane } from '@/lib/lane/types';
import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export type PacketReviewState =
  | 'working'
  | 'ready-to-merge'
  | 'needs-revision'
  | 'merged'
  | 'failed';

export interface DeriveReviewStateOrchestratorReview {
  verdict: 'approved' | 'rejected';
  reviewMode?: import('./review-run-evidence').ReviewMode;
  runEvidence?: import('./review-run-evidence').ReviewRunEvidence;
  verdictLabel?: string;
  ts: string;
  summary: string;
}

export interface DeriveReviewStateMergeGate {
  verdict: 'passing' | 'failing';
  ts: string;
  checks: string[];
  diffBase?: PacketDiffBaseResolution;
}

export interface DeriveReviewStateInput {
  packet: OrchestratorPacket;
  lane: Lane | null;
  orchestratorReview?: DeriveReviewStateOrchestratorReview | null;
  mergeGate?: DeriveReviewStateMergeGate | null;
}

export interface DeriveReviewStateResult {
  state: PacketReviewState;
  /**
   * Best-effort ISO timestamp describing when the state last changed. Prefers
   * the most-recent contributing signal (merge-gate > orchestrator review >
   * lane event > packet event). Falls back to `new Date().toISOString()` when
   * no timestamps are available so the response field is always populated.
   */
  stateChangedAt: string;
}

function pickLatestTimestamp(candidates: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > latestMs) {
      latestMs = parsed;
      latest = candidate;
    }
  }

  return latest;
}

/**
 * Deterministic state machine. Order matters — the first matching rule wins.
 *
 *   1. `merged`          — the lane reached the terminal merged outcome, or
 *                          the packet carries a merge receipt.
 *   2. `failed`          — lane or packet status is `failed`.
 *   3. `needs-revision`  — orchestrator rejected the diff OR the merge gate
 *                          flagged any blocking violation.
 *   4. `ready-to-merge`  — orchestrator approved AND the merge gate is
 *                          currently passing.
 *   5. `working`         — nothing above applies; the packet is still in
 *                          flight (queued / launching / running / reviewing).
 */
export function derivePacketReviewState(input: DeriveReviewStateInput): DeriveReviewStateResult {
  const { packet, lane, orchestratorReview, mergeGate } = input;
  const now = new Date().toISOString();

  // 1. merged
  if (
    (lane?.status === 'completed' && lane.outcome === 'merged')
    || Boolean(packet.releaseStatePayload?.mergeCommit?.trim())
  ) {
    const ts = pickLatestTimestamp([
      orchestratorReview?.ts,
      mergeGate?.ts,
      lane?.lastEventAt ?? null,
      packet.lastEventAt ?? null,
      packet.review?.recordedAt,
    ]) ?? now;
    return { state: 'merged', stateChangedAt: ts };
  }

  // 2. failed
  // An archived lane on a non-failed packet usually means success + cleanup,
  // so don't treat archive as failure on its own.
  if (packet.status === 'failed' || lane?.status === 'failed') {
    const ts = pickLatestTimestamp([
      lane?.lastEventAt ?? null,
      packet.lastEventAt ?? null,
    ]) ?? now;
    return { state: 'failed', stateChangedAt: ts };
  }

  // 3. needs-revision — orchestrator said no OR merge gate says no.
  if (orchestratorReview?.verdict === 'rejected' || mergeGate?.verdict === 'failing') {
    const ts = pickLatestTimestamp([
      orchestratorReview?.verdict === 'rejected' ? orchestratorReview.ts : null,
      mergeGate?.verdict === 'failing' ? mergeGate.ts : null,
      lane?.lastEventAt ?? null,
    ]) ?? now;
    return { state: 'needs-revision', stateChangedAt: ts };
  }

  // 4. ready-to-merge — orchestrator said yes AND merge gate is clean.
  if (orchestratorReview?.verdict === 'approved' && mergeGate?.verdict === 'passing') {
    const ts = pickLatestTimestamp([
      orchestratorReview.ts,
    ]) ?? now;
    return { state: 'ready-to-merge', stateChangedAt: ts };
  }

  // 5. working — default catch-all.
  const ts = pickLatestTimestamp([
    lane?.lastEventAt ?? null,
    packet.lastEventAt ?? null,
    orchestratorReview?.ts ?? null,
    mergeGate?.ts ?? null,
  ]) ?? now;
  return { state: 'working', stateChangedAt: ts };
}
