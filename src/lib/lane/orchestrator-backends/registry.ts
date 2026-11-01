/**
 * Orchestrator backend registry.
 *
 * Resolves the active orchestrator backend. Each backend is an
 * `OrchestratorBackend` implementation living in its own sibling file
 * (`claude.ts`, `codex.ts`, `openclaw.ts`, `acp.ts`) — registered here in
 * `BACKENDS`. The Codex/Claude delegates call straight into the existing,
 * `orchestrator-session.ts` / `codex-orchestrator-session.ts`
 * modules. Adding a backend is one new file + one entry in `BACKENDS`.
 *
 * Orchestrator call sites use `getActiveOrchestratorBackend()` instead of
 * branching on `inAppOrchestratorEnabled` directly — the registry is the
 * single chokepoint that knows which backend is active.
 */

import { resolveOrchestratorBackendId, resolveReviewerBackendId } from './active-backend';
import { claudeBackend } from './claude';
import { codexBackend, codexLiveSteerForThread } from './codex';
import { openclawBackend } from './openclaw';
import { acpBackend, hermesBackend, opencodeBackend } from './acp';
import { collideBackend } from './moa';
import { fableBackend } from './fable';
import { o8Backend } from './o8';
import { piBackend } from './pi';
import { museBackend } from './muse';
import type { OrchestratorBackend, OrchestratorBackendId } from './types';
import { withOperatingAgreement } from '@/lib/operator/operating-agreement';
import { applyOrchestrationMode } from './orchestration-mode';
import { withVisualizationInstructions } from '@/lib/visualizations/orchestrator-prompt';
import { assertOrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';
import { runWithThreadProviderInstance } from '@/lib/providers/instance-launch';

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Registered backends. `openclaw` is added when its backend module ships;
 * `getOrchestratorBackend` falls back to Codex for an unregistered id.
 */
export function withOrchestrationMode(
  backend: OrchestratorBackend,
): OrchestratorBackend {
  return {
    ...backend,
    sendTurn(repoPath, message, onEvent, options) {
      try {
        assertOrchestratorPermissionMode(backend.id, options?.permissionMode, options?.toolProfile);
      } catch (error) {
        return Promise.reject(error);
      }
      const resolved = applyOrchestrationMode(message, options);
      const prompt = ['openclaw', 'hermes', 'acp', 'opencode', 'muse'].includes(backend.id)
        ? withVisualizationInstructions(resolved.message, repoPath, options?.threadId) : resolved.message;
      // Settings › Providers instances: the thread's bound instance (binary, home, env) for this turn.
      return runWithThreadProviderInstance(backend.id, options?.threadId,
        () => backend.sendTurn(repoPath, withOperatingAgreement(prompt), onEvent, resolved.options));
    },
  };
}

const BACKENDS: Partial<Record<OrchestratorBackendId, OrchestratorBackend>> = {
  claude: withOrchestrationMode(claudeBackend),
  codex: withOrchestrationMode(codexBackend),
  openclaw: withOrchestrationMode(openclawBackend),
  hermes: withOrchestrationMode(hermesBackend),
  acp: withOrchestrationMode(acpBackend),
  opencode: withOrchestrationMode(opencodeBackend),
  collide: withOrchestrationMode(collideBackend),
  fable: withOrchestrationMode(fableBackend),
  o8: withOrchestrationMode(o8Backend),
  pi: withOrchestrationMode(piBackend),
  muse: withOrchestrationMode(museBackend),
};

/** The default backend — also the fallback for any unregistered id. */
const DEFAULT_BACKEND = BACKENDS.codex!;

export function getOrchestratorBackend(id: OrchestratorBackendId, target?: { repoPath: string; threadId: string }): OrchestratorBackend {
  const backend = BACKENDS[id] ?? DEFAULT_BACKEND;
  return id === 'codex' && target
    ? { ...backend, liveSteer: codexLiveSteerForThread(target.repoPath, target.threadId) } : backend;
}

// Active-id resolution lives in the server leaf `active-backend.ts`; billing
// classes in the PURE leaf `billing.ts` (client-bundle-safe) — so brain-access/
// packet-prompt and the client compaction trigger resolve what they need
// without pulling every backend implementation through this module.
// Re-exported for existing call-sites (ws-server). IMPORT-PATH TRAP: client
// code must import these from './billing' / './active-backend' DIRECTLY —
// importing via this registry pulls every backend implementation (and their
// session modules) into the bundle.
export { resolveOrchestratorBackendId, resolveReviewerBackendId } from './active-backend';
export { isMeteredOrchestratorBackend } from './billing';

/** The active backend, resolved from operator settings. */
export function getActiveOrchestratorBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveOrchestratorBackendId());
}

/** The backend that runs lane auto-reviews ('follow' rides the orchestrator). */
export function getActiveReviewerBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveReviewerBackendId());
}
