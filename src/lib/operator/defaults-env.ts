import 'server-only';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { UpdateAutoApply } from '@/lib/app-update/types';
import { isSubscriptionProfile, type SubscriptionProfile } from './subscription-profile';

/**
 * Setting vocabularies + env-var overrides for {@link OperatorDefaults}
 * (extracted from defaults.ts when it outgrew the file ceiling — this module
 * holds the leaf types, their validators, and the `envXxx()` readers;
 * defaults.ts re-exports the public names so import sites are unchanged).
 */
export const DISPATCH_RUNTIMES: OrchestratorRuntime[] = listDispatchableRuntimes();
export function isDispatchRuntime(value: unknown): value is OrchestratorRuntime {
  return typeof value === 'string' && (DISPATCH_RUNTIMES as string[]).includes(value);
}

export type OverlapGateMode = 'advisory' | 'strict';

/**
 * Q&A Class A composer routing (#971, 'fastest' added #1124-era perf pass).
 *   - `auto` / `haiku-cli` — current chain: Haiku CLI tier 1, then Codex/OpenRouter/Flash/Sonnet CLI fallbacks.
 *   - `sonnet-cli` — lead with Sonnet CLI for higher quality. Skips Haiku + Codex tiers.
 *   - `fastest` — lead with OpenRouter flash-lite (~1-3s, pennies, daily-capped), free tiers as fallback.
 * Eval-mode (smoke gate) is unaffected — always routes through OpenRouter Sonnet 4.6.
 */
export type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';

export function isClassAComposer(value: unknown): value is ClassAComposer {
  // 'fastest' was missing here after #1124 added it to the type — Settings
  // could offer it but updateOperatorDefaults rejected the write.
  return value === 'auto' || value === 'haiku-cli' || value === 'sonnet-cli' || value === 'fastest';
}

/**
 * Brain answer payer selection. `auto` uses managed inference for an entitled
 * plan and keeps the established free-user cascade. `subscription` is the
 * deliberate opt-in that permits connected subscription CLIs for Brain asks.
 */
export type BrainRoutingMode = 'auto' | 'subscription';

export function isBrainRoutingMode(value: unknown): value is BrainRoutingMode {
  return value === 'auto' || value === 'subscription';
}

/**
 * "Workers use the Brain" (2026-06-11). Whether dispatched worker agents get
 * Engineering Brain access (`o8 ask`) injected into their packet prompt.
 *   - `off`  — workers never told about the Brain.
 *   - `auto` — Brain on for NON-frontier runtimes only (tier !== 'frontier'
 *     in runtime-capabilities). Frontier workers stay lean; weaker and local
 *     models get repo knowledge without burning context on searches.
 *   - `all`  — every worker gets it (the dogfood / A-B setting).
 * Per-packet `useBrain` overrides this either way.
 */
export type WorkersUseBrain = 'off' | 'auto' | 'all';

export function isWorkersUseBrain(value: unknown): value is WorkersUseBrain {
  return value === 'off' || value === 'auto' || value === 'all';
}

/** Whether checked-in workspace manifest commands may run during packet launch. */
export type WorkspaceManifestPolicy = 'disabled' | 'one-approval' | 'auto';

export function isWorkspaceManifestPolicy(value: unknown): value is WorkspaceManifestPolicy {
  return value === 'disabled' || value === 'one-approval' || value === 'auto';
}

/** Which backend drives the in-app Orchestrator. 'auto' = the legacy
 *  inAppOrchestratorEnabled derivation; a specific id forces that backend. */
// Single source: the pure leaf, so client surfaces can share it without
// dragging `server-only` into their bundle. Re-exported here for the existing
// server call-sites.
import { isOrchestratorBackendSetting, type OrchestratorBackendSetting } from './backend-setting';

export { isOrchestratorBackendSetting };
export type { OrchestratorBackendSetting };

/**
 * Which backend runs lane auto-reviews. 'follow' (default) rides the active
 * orchestrator backend — byte-identical to pre-setting behavior. Splitting the
 * roles lets the bulk orchestrator run on the Codex sub while reviews — short,
 * bounded, accuracy-critical — run on Claude (opposite-frontier pairing:
 * Codex writes, Claude reviews). Q ruling 2026-07-07. Env: `O8_REVIEWER_BACKEND`.
 */
export type ReviewerBackendSetting = 'follow' | 'codex' | 'claude';

export function isReviewerBackendSetting(value: unknown): value is ReviewerBackendSetting {
  return value === 'follow' || value === 'codex' || value === 'claude';
}

export type CollideAggregator = 'auto' | 'claude' | 'codex';

export function isCollideAggregator(value: unknown): value is CollideAggregator {
  return value === 'auto' || value === 'claude' || value === 'codex';
}

/**
 * Where a PR row opens (Git & PRs tab). 'in-app' (default) renders the embedded
 * PrPanel; 'browser' hands the github.com/.../pull URL to the OS browser.
 * Byte-identical to pre-setting behavior at the default. Env: `O8_PR_LINK_DESTINATION`.
 */
export type PrLinkDestination = 'in-app' | 'browser';

export function isPrLinkDestination(value: unknown): value is PrLinkDestination {
  return value === 'in-app' || value === 'browser';
}

/**
 * Clean a stored/typed branch prefix into a safe leading branch segment
 * (`[a-z0-9/_-]`, collapsed slashes/dashes, no leading/trailing separators).
 * Returns null when nothing usable remains — callers validate-or-null so a junk
 * value falls through to the current-behavior default rather than corrupting a
 * branch name.
 */
export function sanitizeBranchPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 40);
  return cleaned || null;
}

// ── Env overrides ──

export function isParallelCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function envParallelCap(): number | null {
  const raw = process.env.O8_MAX_PARALLEL_DISPATCHES;
  if (!raw) return null;
  const parsed = Number(raw);
  return isParallelCap(parsed) ? parsed : null;
}

export function envSubscriptionProfile(): SubscriptionProfile | null {
  const raw = process.env.O8_SUBSCRIPTION_PROFILE?.trim();
  if (raw && isSubscriptionProfile(raw)) return raw;
  return null;
}

export function envOverlapGate(): OverlapGateMode | null {
  const raw = process.env.O8_STRICT_OVERLAP_GATE;
  if (raw === '1') return 'strict';
  if (raw === '0') return 'advisory';
  return null;
}

export function envSupervisorAutoEscalate(): boolean | null {
  const raw = process.env.O8_SUPERVISOR_AUTO_ESCALATE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envHealBotEnabled(): boolean | null {
  const raw = process.env.O8_HEAL_BOT_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envPromptCachingEnabled(): boolean | null {
  const raw = process.env.O8_PROMPT_CACHING;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envThinkingEffort(): ThinkingEffort | null {
  const raw = process.env.O8_THINKING_EFFORT;
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envOrchestratorModel(): string | null {
  const raw = process.env.O8_ORCHESTRATOR_MODEL;
  return raw?.trim() || null;
}

export function envDefaultDispatchRuntime(): OrchestratorRuntime | null {
  const raw = process.env.O8_DEFAULT_DISPATCH_RUNTIME?.trim();
  if (!raw) return null;
  if (isDispatchRuntime(raw)) return raw;
  return null;
}

export function envCodexWorkerEffort(): ThinkingEffort | null {
  const raw = process.env.O8_CODEX_WORKER_EFFORT?.trim();
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envClaudeWorkerEffort(): ThinkingEffort | null {
  const raw = process.env.O8_CLAUDE_WORKER_EFFORT?.trim();
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envDefaultDispatchModel(): string | null {
  const raw = process.env.O8_DISPATCH_MODEL;
  return raw?.trim() || null;
}

export function envLocalInferenceBaseUrl(): string | null {
  return process.env.O8_LOCAL_INFERENCE_BASE_URL?.trim() || null;
}

export function envLocalEmbedModel(): string | null {
  return process.env.O8_LOCAL_EMBED_MODEL?.trim() || null;
}

export function envLocalChatModel(): string | null {
  return process.env.O8_LOCAL_CHAT_MODEL?.trim() || null;
}

export function envExperimentalOpencode(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_OPENCODE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalGemini(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_GEMINI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalChat(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CHAT;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalCanvas(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CANVAS;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envNativeBrowserView(): boolean | null {
  const raw = process.env.O8_NATIVE_BROWSER_VIEW;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envClassAComposer(): ClassAComposer | null {
  const raw = process.env.O8_CLASS_A_COMPOSER?.trim();
  if (raw && isClassAComposer(raw)) return raw;
  return null;
}

export function envBrainRoutingMode(): BrainRoutingMode | null {
  const raw = process.env.O8_BRAIN_ROUTING_MODE?.trim();
  return raw && isBrainRoutingMode(raw) ? raw : null;
}

export function envInAppOrchestratorEnabled(): boolean | null {
  const raw = process.env.O8_IN_APP_ORCHESTRATOR_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBrainUseClaudeCli(): boolean | null {
  const raw = process.env.O8_BRAIN_USE_CLAUDE_CLI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBrainWarmupEnabled(): boolean | null {
  const raw = process.env.O8_BRAIN_WARMUP;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envWorkersUseBrain(): WorkersUseBrain | null {
  const raw = process.env.O8_WORKERS_USE_BRAIN?.trim();
  if (raw && isWorkersUseBrain(raw)) return raw;
  return null;
}

export function envWorkspaceManifestPolicy(): WorkspaceManifestPolicy | null {
  const raw = process.env.O8_WORKSPACE_MANIFEST_POLICY?.trim();
  if (raw && isWorkspaceManifestPolicy(raw)) return raw;
  return null;
}

export function envOrchestratorBackend(): OrchestratorBackendSetting | null {
  const raw = process.env.O8_ORCHESTRATOR_BACKEND?.trim();
  if (raw && isOrchestratorBackendSetting(raw)) return raw;
  return null;
}

export function envReviewerBackend(): ReviewerBackendSetting | null {
  const raw = process.env.O8_REVIEWER_BACKEND?.trim();
  if (raw && isReviewerBackendSetting(raw)) return raw;
  return null;
}

export function envBuyinDocEnabled(): boolean | null {
  const raw = process.env.O8_BUYIN_DOC;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envCollideAggregator(): CollideAggregator | null {
  const raw = process.env.O8_COLLIDE_AGGREGATOR_DEFAULT?.trim();
  if (raw && isCollideAggregator(raw)) return raw;
  return null;
}

/**
 * `O8_NO_PHONE_HOME=1` turns off automatic updates, crash-log upload and crash
 * reports for one run, over the saved settings. The launcher reads the same
 * variable and skips its update checks.
 */
export function envNoPhoneHome(): boolean {
  return process.env.O8_NO_PHONE_HOME === '1';
}

export function envUpdateAutoApply(): UpdateAutoApply | null {
  if (envNoPhoneHome()) return 'off';
  const raw = process.env.O8_UPDATE_AUTO_APPLY?.trim()
    ?? process.env.O8_AUTO_APPLY_UPDATES?.trim();
  if (raw === 'off' || raw === 'idle') return raw;
  if (raw === 'when-idle') return 'idle';
  return null;
}

export function envTelemetryOptIn(): boolean | null {
  if (envNoPhoneHome()) return false;
  const raw = process.env.O8_TELEMETRY_OPT_IN;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envTelemetryIngestUrl(): string | null {
  return process.env.O8_TELEMETRY_INGEST_URL?.trim() || null;
}

export function envCrashReports(): boolean | null {
  if (envNoPhoneHome()) return false;
  const raw = process.env.O8_CRASH_REPORTS;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBranchPrefix(): string | null {
  return sanitizeBranchPrefix(process.env.O8_BRANCH_PREFIX);
}

export function envCommitAttribution(): boolean | null {
  const raw = process.env.O8_COMMIT_ATTRIBUTION;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envPrLinkDestination(): PrLinkDestination | null {
  const raw = process.env.O8_PR_LINK_DESTINATION?.trim();
  if (raw && isPrLinkDestination(raw)) return raw;
  return null;
}

/**
 * Parse a positive-number retention limit env var. `0` (and any non-positive /
 * non-finite value) is rejected → null → falls through to the file/fallback,
 * so `O8_WORKTREE_MAX_COUNT=0` cannot silently disable the guard by accident.
 * A caller wanting "unbounded" sets the persisted knob, not the env, to 0.
 */
function envPositiveNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function envWorktreeMaxCount(): number | null {
  return envPositiveNumber('O8_WORKTREE_MAX_COUNT');
}

export function envWorktreeMaxTotalGb(): number | null {
  return envPositiveNumber('O8_WORKTREE_MAX_TOTAL_GB');
}

export function envStorageReserveRatio(): number | null {
  const raw = process.env.O8_STORAGE_RESERVE_RATIO?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function envStorageReserveFloorGb(): number | null {
  const value = envPositiveNumber('O8_STORAGE_RESERVE_FLOOR_GB');
  return value !== null && value <= 10000 ? value : null;
}
