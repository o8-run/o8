/**
 * The orchestrator-backend SETTING union, in one place.
 *
 * PURE LEAF — no imports, no `server-only`. That is the entire point. The
 * canonical definition used to live in `defaults-env.ts`, which imports
 * `server-only`, so every client surface that needed the union kept its own
 * hand-maintained copy. Three copies existed by 2026-08-04 and they had
 * already drifted: `settings/dispatch-shared.tsx` was missing `fable`, `o8`,
 * AND `opencode`, so Settings typed a backend the composer could actually
 * select as invalid.
 *
 * Adding a backend now means editing this file, and nothing else has an
 * opinion. Note this is the SETTING union (it carries `'auto'`), which is
 * deliberately distinct from `OrchestratorBackendId` in
 * `lane/orchestrator-backends/types.ts` — that one names real backends only.
 */

export type OrchestratorBackendSetting =
  | 'auto'
  | 'codex'
  | 'claude'
  | 'openclaw'
  | 'hermes'
  | 'collide'
  | 'fable'
  | 'o8'
  | 'opencode'
  | 'pi'
  | 'acp';

const VALUES = new Set<string>([
  'auto', 'codex', 'claude', 'openclaw', 'hermes', 'collide', 'fable', 'o8', 'opencode', 'pi', 'acp',
]);

export function isOrchestratorBackendSetting(value: unknown): value is OrchestratorBackendSetting {
  return typeof value === 'string' && VALUES.has(value);
}
