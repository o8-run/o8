/**
 * Codex owned-session adapter.
 *
 * This file is the Codex-specific adapter on top of the generic
 * owned-session primitive (`@/lib/runtimes/shared/owned-session`).
 *
 * What's Codex-specific and lives here:
 *   - launchArgs / resumeArgs (Codex exec CLI flags, danger-full-access sandbox)
 *   - parseRunLog (Codex JSONL stream: thread.started, turn.started, event_msg,
 *     response_item, item.started/completed, turn.completed, plus tool paths)
 *   - parseRunEvidence (extract agent_message + command_execution items)
 *   - stderr noise patterns (MCP teardown warnings, etc.)
 *
 * What moved to the shared primitive:
 *   - spawn/launch/resume/interrupt pipelines
 *   - tmux bridge spawn + detached spawn fallback
 *   - metadata JSON read/write, runs/ directory layout
 *   - lifecycle derivation + surface/status/current-task building
 *   - stale-session filtering, TTL fleet cache + inflight dedupe + generation
 *   - auto-retry logic
 *   - review packet assembly (wraps getRuntimeRepoReview + worktree join)
 */

import { readLiveCodexRuntimeCapacity } from './live-capacity';
import path from 'node:path';
import os from 'node:os';
import { codexParseRunLog } from './owned-log';
export { codexParseRunLog } from './owned-log';
import type { RuntimeReviewCommandEvidence } from '@/lib/fleet/types';
import {
  createOwnedSessionStore,
  previewText,
  type OwnedRunEvidence,
  type OwnedLaunchRequest,
  type OwnedRunOutcome,
  type OwnedRunRecord,
  type OwnedRuntimeAdapter,
} from '@/lib/runtimes/shared/owned-session';
import {
  workerMcpServerNameIsValid,
  type ResolvedWorkerMcpServer,
} from '@/lib/mcp/worker-injection';
import { codexModelArgs, parseLocalModel } from './local-model';
import { resolveCodexReasoningEffort } from './reasoning-effort';
import { codexSolCompatibilityFallback } from './model-compatibility';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getDataDir } from '@/lib/data-dir-migration';
import { codexSandboxLaunchArgs, codexSandboxResumeArgs } from '@/lib/codex/read-only-args';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import { isReadOnlyRuntimeConfig, workModeRuntimeConfig } from '@/lib/runtimes/shared/owned-session/work-mode';
import { executionCarrierRuntimeConfig, type ExecutionCarrierId } from '@/lib/runtimes/shared/execution-carrier';
// Re-export the fleet additions shape under its original Codex name.
export type { OwnedCodexFleetAdditions } from '@/lib/runtimes/shared/owned-session';
// ── Codex-specific types (preserved signatures) ──────────────────────────────

export type OwnedCodexLaunchRequest = Omit<OwnedLaunchRequest, 'runtimeConfig'> & {
  /** Durable packet work mode; 'read-only' hardens argv and the OS sandbox. */
  workMode?: WorkerWorkMode;
  executionCarrier?: ExecutionCarrierId;
};

export type OwnedCodexLaunchResponse = {
  ok: boolean;
  runtime: 'codex';
  surfaceId: string;
  note: string;
  sideEffect?: 'none' | 'unknown';
};

type OwnedReviewDisposition = 'watching' | 'resolved';
// ── Codex JSONL helpers ──────────────────────────────────────────────────────

// ── Codex CLI argv builders ──────────────────────────────────────────────────

// Codex CLI 0.130.0 injects the hosted `image_generation` tool defaulted to a
// nonexistent `gpt-image-2` model, which OpenAI 400s on every turn — killing
// dispatch at spawn. o8 workers write code, never images, so disable it. Scoped
// to o8-dispatched workers; the user's interactive Codex.app is untouched.
const DISABLE_IMAGE_TOOL = ['-c', 'tools.image_generation=false'];

// #1402 — dispatched workers run with the user's ~/.codex/config.toml IGNORED.
// Inherited MCP servers were killing workers: a dead/auth-broken HTTP MCP entry
// makes rmcp transport workers crash-loop at spawn (slow launches) and the
// session-cleanup DELETE-404 signature preceded 6 silent worker deaths in one
// night. Workers inherit no user MCP config; operator-attached packet servers
// are added explicitly through per-run overrides below. Everything else a
// worker needs (model, effort, sandbox, image-tool off) is passed by flag. The
// user's interactive Codex and the codex orchestrator session are untouched.
const IGNORE_USER_CONFIG = ['--ignore-user-config'];

/**
 * Codex reasoning-effort flag. Emitted ONLY for an explicit tier — undefined /
 * 'adaptive' → [] so the launch stays at Codex's default (parity: unset effort
 * produces byte-identical args to before this feature). `max`/`ultra` pass
 * through only on flagship models; every other model clamps to `xhigh` (shared with
 * the orchestrator via resolveCodexReasoningEffort).
 */
export function codexReasoningEffortArgs(effort?: ThinkingEffort, model?: string): string[] {
  if (!effort || effort === 'adaptive') return [];
  return ['-c', `model_reasoning_effort=${resolveCodexReasoningEffort(effort, model)}`];
}

export function codexWorkerMcpOverrideArgs(servers: ResolvedWorkerMcpServer[]): string[] {
  return servers
    .filter((server) => workerMcpServerNameIsValid(server.name))
    .flatMap((server) => {
      const prefix = `mcp_servers.${server.name}`;
      const args = `[${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
      const env = `{${Object.entries(server.env ?? {})
        .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
        .join(', ')}}`;
      return [
        '-c', `${prefix}.command=${JSON.stringify(server.command)}`,
        '-c', `${prefix}.args=${args}`,
        '-c', `${prefix}.env=${env}`,
        ...(server.id === 'builtin:devices' ? ['-c', `${prefix}.env_vars=["O8_WORKER_TOKEN"]`] : []),
      ];
    });
}

export function codexLaunchArgs(ctx: {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: ThinkingEffort;
  workerMcpServers?: ResolvedWorkerMcpServer[];
  runtimeConfig?: Record<string, string>;
}): string[] {
  return [
    'exec',
    '--json',
    // Read-only -> approvals off + Codex's INNER sandbox off (o8's forced
    // outer seatbelt is the enforcement; nesting it fails — read-only-args.ts).
    // A write packet keeps the previous full-access flags, in the same order.
    ...codexSandboxLaunchArgs(isReadOnlyRuntimeConfig(ctx.runtimeConfig)),
    ...DISABLE_IMAGE_TOOL,
    ...IGNORE_USER_CONFIG,
    ...codexWorkerMcpOverrideArgs(ctx.workerMcpServers ?? []),
    '-C',
    ctx.cwd,
    // `ollama:<model>` / `lmstudio:<model>` → run this worker on a LOCAL model
    // (--oss --local-provider …); a plain name → --model; empty → Codex default.
    ...codexModelArgs(ctx.model),
    // Per-runtime effort surface — no-op unless an explicit tier was requested.
    ...codexReasoningEffortArgs(ctx.effort, ctx.model),
    ctx.prompt,
  ];
}

export function codexResumeArgs(ctx: {
  threadId: string;
  prompt: string;
  model?: string;
  effort?: ThinkingEffort;
  workerMcpServers?: ResolvedWorkerMcpServer[];
  runtimeConfig?: Record<string, string>;
}): string[] {
  const local = parseLocalModel(ctx.model);
  return [
    'exec',
    // Local-provider flags belong to exec, not its resume subcommand.
    ...(local ? ['--oss', '--local-provider', local.provider] : []),
    'resume',
    ctx.threadId,
    '--json',
    // Resume has no -s/--sandbox flag; read-only must use -c instead (#1415).
    ...codexSandboxResumeArgs(isReadOnlyRuntimeConfig(ctx.runtimeConfig)),
    ...DISABLE_IMAGE_TOOL,
    ...IGNORE_USER_CONFIG,
    ...codexWorkerMcpOverrideArgs(ctx.workerMcpServers ?? []),
    ...(local ? ['--model', local.model] : codexModelArgs(ctx.model)),
    ...codexReasoningEffortArgs(ctx.effort, ctx.model),
    ctx.prompt,
  ];
}

// ── Codex JSONL stdout parser ────────────────────────────────────────────────

// ── Codex run-evidence parser (for review packets) ──────────────────────────

function codexParseRunEvidence(raw: string, run: OwnedRunRecord, resolvedOutcome: OwnedRunOutcome): OwnedRunEvidence {
  let assistantSummary: string | undefined;
  const commands = [] as RuntimeReviewCommandEvidence[];
  const finalOutcome = resolvedOutcome ?? run.outcome;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type !== 'item.started' && parsed.type !== 'item.completed') {
        continue;
      }

      const item = (parsed.item ?? {}) as Record<string, unknown>;
      if (item.type === 'agent_message' && parsed.type === 'item.completed') {
        assistantSummary = previewText(String(item.text ?? ''), 220) ?? assistantSummary;
        continue;
      }

      if (item.type !== 'command_execution') {
        continue;
      }

      const itemId = String(item.id ?? `${run.id}:${commands.length}`);
      const current = commands.find((entry) => entry.id === itemId);
      const baseStatus = parsed.type === 'item.started' ? 'running' : 'completed';
      const exitCode = item.exit_code == null ? null : Number(item.exit_code);
      const nextStatus = finalOutcome === 'interrupted'
        ? 'interrupted'
        : parsed.type === 'item.completed' && exitCode && exitCode !== 0
          ? 'failed'
          : finalOutcome === 'failed' && parsed.type !== 'item.completed'
            ? 'failed'
            : baseStatus;
      const nextEntry: RuntimeReviewCommandEvidence = {
        id: itemId,
        command: previewText(String(item.command ?? ''), 180) ?? 'command',
        status: nextStatus,
        exitCode,
        outputPreview: previewText(String(item.aggregated_output ?? ''), 260),
      };

      if (current) {
        Object.assign(current, nextEntry);
      } else {
        commands.push(nextEntry);
      }
    } catch {
      continue;
    }
  }

  if (finalOutcome !== 'running') {
    for (const command of commands) {
      if (command.status !== 'running') continue;
      command.status = finalOutcome === 'finished'
        ? 'completed'
        : finalOutcome === 'interrupted'
          ? 'interrupted'
          : 'failed';
    }
  }

  return {
    assistantSummary,
    commands,
  };
}

// ── Adapter wiring + store ───────────────────────────────────────────────────

/** Patterns in Codex stderr that are non-fatal noise (MCP server teardown, etc.) */
const CODEX_STDERR_NOISE_PATTERNS: RegExp[] = [
  /rmcp::transport::worker.*worker quit/i,
  /mcp.*connection refused/i,
  /mcp.*transport channel closed/i,
];

export const codexOwnedAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'codex',
  observeCapacity: session => readLiveCodexRuntimeCapacity({
    configHome: session.identity?.configHomeRef ?? (process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')),
    identityId: session.identity?.id ?? null,
  }),
  // IMPORTANT: Keep 'codex-owned:' prefix — load-bearing for session routing.
  surfaceIdPrefix: 'codex-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-codex'),
  binaryName: 'codex',
  binaryEnvOverride: 'O8_CODEX_BIN',
  isolatedConfigHomeEnv: 'CODEX_HOME',
  defaultConfigHome: () => process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'),
  workerMcpInjection: 'config-override',
  humanLabel: 'Owned Codex',
  squadShortName: 'Codex',
  sessionIdPrefix: 'codex-owned-',
  launchArgs: codexLaunchArgs,
  resumeArgs: codexResumeArgs,
  parseRunLog: codexParseRunLog,
  parseRunEvidence: codexParseRunEvidence,
  stderrNoise: CODEX_STDERR_NOISE_PATTERNS,
  retryDelayMs: 5_000,
  launchGroupLabel: 'Launch turn',
  resumeGroupLabel: 'Resume turn',
  modelCompatibilityFallback: codexSolCompatibilityFallback,
};

const codexStore = createOwnedSessionStore(codexOwnedAdapter);

// ── Public API (identical signatures to the pre-Wave-2b implementation) ─────

export function invalidateOwnedCodexFleetCache(): void {
  codexStore.invalidateFleetCache();
}

export async function archiveOwnedCodexSession(surfaceId: string) {
  return codexStore.archiveSession(surfaceId);
}

export async function ownedCodexSessionState(surfaceId: string) {
  return codexStore.sessionState(surfaceId);
}

export async function sweepOrphanedCodexSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
  return codexStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs);
}

export async function launchOwnedCodexSession(
  request: OwnedCodexLaunchRequest,
): Promise<OwnedCodexLaunchResponse> {
  const result = await codexStore.launch({
    ...request,
    // Pinned like the model/carrier pins, so retry/resume/rerun of a read-only
    // packet stays read-only even if the caller omits the mode.
    runtimeConfig: {
      ...workModeRuntimeConfig(request.workMode),
      ...executionCarrierRuntimeConfig(request.executionCarrier),
    },
  });
  return {
    ok: result.ok,
    runtime: 'codex',
    surfaceId: result.surfaceId,
    note: result.note,
    sideEffect: result.sideEffect,
  };
}

export async function continueOwnedCodexSession(surfaceId: string, prompt: string) {
  return codexStore.resume(surfaceId, prompt);
}

export async function interruptOwnedCodexSession(surfaceId: string) {
  return codexStore.interrupt(surfaceId);
}

export async function setOwnedCodexReviewDisposition(
  surfaceId: string,
  disposition: OwnedReviewDisposition,
) {
  return codexStore.setReviewDisposition(surfaceId, disposition);
}

export async function getOwnedCodexTelemetrySources(surfaceId: string) {
  return codexStore.getTelemetrySources(surfaceId);
}

export async function getOwnedCodexSessionIdentityId(surfaceId: string) {
  return codexStore.getSessionIdentityId(surfaceId);
}

export async function getOwnedCodexRuntimeTail(surfaceId: string, limit?: number) {
  return codexStore.getRuntimeTail(surfaceId, limit);
}

export async function getOwnedCodexReviewPacket(surfaceId: string) {
  return codexStore.getReviewPacket(surfaceId);
}

export async function getOwnedCodexFleetAdditions(
  options: { fresh?: boolean } = {},
) {
  return codexStore.getFleetAdditions(options);
}
