/**
 * Orchestrator billing classes (2026-07-02).
 *
 * A scarce, per-token-metered top model is the RECURRING pattern every frontier
 * cycle — Fable is only the launch instance. So the decisions-only-window
 * policies (Brain-always-on, native-tool lockout, compact returns, compaction)
 * key on the billing class of the active orchestrator backend, never on a
 * backend name at call-sites. The next metered model is one map row here, not
 * a refactor.
 *
 * PURE leaf — type-only imports, safe in BOTH the server and the client bundle
 * (the auto-compact trigger in useOrchestratorStream keys its threshold on
 * this predicate). The server-side "which backend is active" resolver lives in
 * `active-backend.ts` (it reads operator defaults from disk).
 */

import type { OrchestratorBackendId } from './types';

/**
 * How an orchestrator backend is billed. `metered` = per-token API billing
 * (every token in the window costs money — the decisions-only policies apply);
 * `subscription` = flat-rate pool (Claude Max, ChatGPT Plus/Codex, provider
 * subs behind openclaw/Hermes); `free` = local inference (reserved — no
 * backend ships it yet).
 */
export type OrchestratorBillingClass = 'metered' | 'subscription' | 'free';

export const ORCHESTRATOR_BACKEND_BILLING: Record<OrchestratorBackendId, OrchestratorBillingClass> = {
  codex: 'subscription',
  claude: 'subscription',
  openclaw: 'subscription',
  hermes: 'subscription',
  acp: 'subscription',
  collide: 'subscription',
  fable: 'metered',
  // The composer's o8 choice runs on bundled Pi (#3408), so it bills like Pi.
  o8: 'metered',
  // opencode routes through the operator's OWN provider credentials (OpenRouter,
  // Google, xAI, or opencode's gateway), so cost tracks the model they pick,
  // not a pool o8 knows about. `metered` is the safe read: it applies the
  // decisions-only window policies, which cost a little context and never cost
  // money. Claiming `subscription` here would disable those policies on a rail
  // that can be genuinely per-token billed.
  opencode: 'metered',
  // Bundled Pi draws per token on the o8 model allowance (the paid weekly or
  // free daily allowance), so the decisions-only window policies apply.
  pi: 'metered',
};

export function orchestratorBackendBillingClass(id: OrchestratorBackendId): OrchestratorBillingClass {
  return ORCHESTRATOR_BACKEND_BILLING[id] ?? 'subscription';
}

export function isMeteredOrchestratorBackend(id: OrchestratorBackendId): boolean {
  return orchestratorBackendBillingClass(id) === 'metered';
}
