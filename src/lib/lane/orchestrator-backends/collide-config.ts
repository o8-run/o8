/**
 * Collide (MoA) config resolution.
 *
 * The default brain is {claude, codex} → claude: Claude + Codex propose
 * independently, Claude aggregates + executes. Resolution layers (highest wins):
 *   operator settings (collideProposers / collideAggregator) → env → code default.
 *
 * The operator-settings layer is wired in Step 4/5; today this resolves from env
 * + the code default so the engine is usable the moment it's registered.
 */

import type { OrchestratorBackendId } from './types';
import type { MoaConfig, MoaParticipant } from './moa';
import { resolveCollideAggregatorSync, type CollideAggregator } from '@/lib/operator/defaults';
import { MODEL_IDS } from '@/lib/models';

/** Default brain: Claude (Opus, max) + the configured Codex flagship (xhigh), synthesized by Claude. */
export const DEFAULT_COLLIDE_CONFIG: MoaConfig = {
  id: 'collide',
  label: 'Collide',
  proposers: [
    { backend: 'claude', model: MODEL_IDS.orchestratorDefault, thinkingEffort: 'max' },
    { backend: 'codex', model: MODEL_IDS.codexDefault, thinkingEffort: 'xhigh' },
  ],
  aggregator: { backend: 'claude', model: MODEL_IDS.orchestratorDefault },
};

const VALID_BACKENDS: OrchestratorBackendId[] = ['claude', 'codex'];

function coerceParticipant(raw: unknown): MoaParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const backend = obj.backend;
  if (typeof backend !== 'string' || !VALID_BACKENDS.includes(backend as OrchestratorBackendId)) return null;
  const participant: MoaParticipant = { backend: backend as OrchestratorBackendId };
  if (typeof obj.model === 'string' && obj.model.trim()) participant.model = obj.model.trim();
  if (typeof obj.thinkingEffort === 'string') participant.thinkingEffort = obj.thinkingEffort as MoaParticipant['thinkingEffort'];
  return participant;
}

function parseProposersEnv(raw: string | undefined): MoaParticipant[] | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const proposers = parsed.map(coerceParticipant).filter((p): p is MoaParticipant => p !== null);
    return proposers.length > 0 ? proposers : null;
  } catch {
    return null;
  }
}

function parseAggregatorEnv(raw: string | undefined): MoaParticipant | null {
  if (!raw || !raw.trim()) return null;
  try {
    return coerceParticipant(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A `fable` composer backend collides as Claude (Fable is a Claude model). */
function collideBackendFamily(backend?: OrchestratorBackendId): 'codex' | 'claude' {
  return backend === 'codex' ? 'codex' : 'claude';
}

/** Which family a raw model id belongs to (gpt-* → codex, else claude). */
function modelFamily(model: string): 'codex' | 'claude' {
  return /^gpt/i.test(model) ? 'codex' : 'claude';
}

function aggregatorFor(
  defaultSetting: CollideAggregator,
  activeBackend?: OrchestratorBackendId,
  baseModel?: string,
): MoaParticipant {
  const backend: 'codex' | 'claude' = defaultSetting === 'auto'
    ? collideBackendFamily(activeBackend)
    : defaultSetting;
  const fallback = DEFAULT_COLLIDE_CONFIG.proposers.find((p) => p.backend === backend) ?? { backend };
  // A proposer has its own reasoning pin. Choosing the same model to aggregate
  // does not make that private pin an explicit choice for the visible turn.
  const selection: MoaParticipant = { backend, model: fallback.model };
  // Q ruling 2026-07-11: Collide's aggregator is the model the operator actually
  // picked in the composer — not the house default. When the chosen model
  // belongs to the aggregator's family, run it as the aggregator (Fable, Terra,
  // Sol, Opus, Sonnet all reach the decider chair). Cross-family picks keep the
  // family default so we never hand codex a claude id (or vice-versa).
  if (baseModel && modelFamily(baseModel) === backend) {
    return { ...selection, model: baseModel };
  }
  return selection;
}

/**
 * Resolve the active Collide config. Pure-ish: reads env each call so an
 * override applies on the next turn. Always returns a valid config (falls back
 * to the code default piece-by-piece). `baseModel` is the composer-selected
 * orchestrator model for the turn — it becomes the aggregator when it belongs
 * to the aggregator's family.
 */
export function resolveCollideConfig(activeBackend?: OrchestratorBackendId, baseModel?: string): MoaConfig {
  const proposers = parseProposersEnv(process.env.O8_COLLIDE_PROPOSERS) ?? DEFAULT_COLLIDE_CONFIG.proposers;
  const aggregator = parseAggregatorEnv(process.env.O8_COLLIDE_AGGREGATOR)
    ?? aggregatorFor(resolveCollideAggregatorSync(), activeBackend, baseModel);
  return { id: 'collide', label: 'Collide', proposers, aggregator };
}
