/**
 * Who pays for a review turn, and on what basis its cost is known (#3742).
 * Subscription backends run on the operator's own plans. Pi and the o8 choice
 * run on the operator's OpenRouter key when the reported model is an
 * `openrouter/<id>` choice, and on o8's managed allowance otherwise. Metered
 * backends bill the operator's own provider account.
 */

import { getSqlite } from '@/lib/db';
import { logUsage } from '@/lib/db/usage';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';
import { ORCHESTRATOR_BACKEND_BILLING } from './orchestrator-backends/billing';
import type { OrchestratorBackendId } from './orchestrator-backends/types';

export type ReviewPayer = 'anthropic-subscription' | 'openai-subscription' | 'operator-subscription'
  | 'operator-metered' | 'openrouter' | 'o8-managed' | 'unknown';
/** `reported`: the provider returned the cost. `subscription`/`allowance`: no per-call charge to the operator. */
export type ReviewCostBasis = 'reported' | 'subscription' | 'allowance' | 'unknown';

export function reviewPayer(backend: string, model: string | null | undefined): { payer: ReviewPayer; costBasis: ReviewCostBasis } {
  if (backend === 'pi' || backend === 'o8') {
    // Without a reported route the payer is not guessed: a managed default would misname an OpenRouter run.
    if (!model) return { payer: 'unknown', costBasis: 'unknown' };
    return isOpenRouterPiModelChoice(model)
      ? { payer: 'openrouter', costBasis: 'reported' }
      : { payer: 'o8-managed', costBasis: 'allowance' };
  }
  if (backend === 'claude') return { payer: 'anthropic-subscription', costBasis: 'subscription' };
  if (backend === 'codex') return { payer: 'openai-subscription', costBasis: 'subscription' };
  // Read the table directly: its lookup helper treats an unknown backend as a subscription.
  const billing = Object.hasOwn(ORCHESTRATOR_BACKEND_BILLING, backend)
    ? ORCHESTRATOR_BACKEND_BILLING[backend as OrchestratorBackendId] : null;
  if (billing === 'subscription') return { payer: 'operator-subscription', costBasis: 'subscription' };
  if (billing === 'metered') return { payer: 'operator-metered', costBasis: 'unknown' };
  return { payer: 'unknown', costBasis: 'unknown' };
}

/**
 * One usage row per review turn. A review that already wrote a row per model
 * call (Pi on OpenRouter or o8's managed model), keyed by the same turn, writes none here.
 */
export function recordReviewTurnUsage(input: {
  laneId: string;
  packetId: string | null;
  repoPath: string;
  reviewTurnId: string;
  backend: string;
  model: string | null;
  surface: string;
  /** The cost the backend reported for the turn, if any; kept as notional for subscription turns. */
  reportedCostUsd: number | null;
}): void {
  const { payer, costBasis: basis } = reviewPayer(input.backend, input.model);
  // Per-call rows already record the turn; a second row would count it twice.
  if (hasReviewCallRows(input.reviewTurnId)) return;
  // A metered backend's reported cost is real spend; a subscription or allowance turn has no per-call charge.
  const metered = payer === 'operator-metered' && input.reportedCostUsd !== null;
  // An OpenRouter turn with no call rows (for example o8's text-only proxy) has no reported cost.
  const costBasis: ReviewCostBasis = metered ? 'reported' : payer === 'openrouter' ? 'unknown' : basis;
  try {
    logUsage({
      userId: null,
      model: input.model ?? input.backend,
      provider: payer === 'anthropic-subscription' ? 'anthropic' : payer === 'openai-subscription' ? 'openai' : 'runtime',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: metered ? input.reportedCostUsd! : 0,
      sessionKey: `review:${input.reviewTurnId}`,
      repoPath: input.repoPath,
      laneId: input.laneId,
      packetId: input.packetId,
      role: 'reviewer',
      runId: input.reviewTurnId,
      agentName: `${input.backend}-reviewer`,
      requestType: 'chat',
      metadata: {
        payer, costSource: costBasis, backend: input.backend, surface: input.surface,
        ...(metered ? {} : { notionalCostUsd: input.reportedCostUsd }),
      },
    });
  } catch (error) {
    console.warn('[review-usage] usage row failed:', error instanceof Error ? error.message : error);
  }
}

function hasReviewCallRows(reviewTurnId: string): boolean {
  try {
    return Boolean(getSqlite().prepare(
      "SELECT 1 FROM usage_logs WHERE role = 'reviewer' AND run_id = ? LIMIT 1",
    ).get(reviewTurnId));
  } catch {
    return false;
  }
}

export interface MissionReviewCost {
  packetId: string;
  reviewTurnId: string;
  /** The reviewer surface: auto-review, merge-gate-review or buyin-doc. */
  surface: string | null;
  model: string | null;
  payer: ReviewPayer;
  costBasis: ReviewCostBasis;
  calls: number;
  costUsd: number;
}

/** Review turns and their spend for the given packets, one entry per turn, in the order they ran. */
export function listReviewCosts(packetIds: string[]): MissionReviewCost[] {
  if (packetIds.length === 0) return [];
  const rows = getSqlite().prepare(`
    SELECT packet_id, run_id, model, provider, cost_usd, metadata_json FROM usage_logs
    WHERE role = 'reviewer' AND run_id IS NOT NULL AND packet_id IN (${packetIds.map(() => '?').join(', ')})
    ORDER BY rowid ASC
  `).all(...packetIds) as Array<{ packet_id: string; run_id: string; model: string | null; provider: string;
    cost_usd: number | null; metadata_json: string | null }>;
  const turns = new Map<string, MissionReviewCost>();
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json ?? '{}') as { payer?: ReviewPayer; costSource?: string; surface?: string;
      carrier?: string };
    const payer = metadata.payer ?? (row.provider === 'openrouter' ? 'openrouter' : 'unknown');
    const turn = turns.get(row.run_id) ?? {
      packetId: row.packet_id, reviewTurnId: row.run_id, surface: metadata.surface ?? null, model: row.model, payer,
      costBasis: row.provider === 'openrouter' ? 'reported' : (metadata.costSource as ReviewCostBasis | undefined) ?? 'unknown',
      calls: 0, costUsd: 0,
    };
    // Per-call rows (OpenRouter's, or any naming its carrier) are one model call each; a turn row is none.
    if (row.provider === 'openrouter' || metadata.carrier) {
      turn.calls += 1;
      if (metadata.costSource === 'unknown') turn.costBasis = 'unknown';
    }
    turn.costUsd = Math.round((turn.costUsd + (row.cost_usd ?? 0)) * 1e6) / 1e6;
    turns.set(row.run_id, turn);
  }
  return [...turns.values()];
}
