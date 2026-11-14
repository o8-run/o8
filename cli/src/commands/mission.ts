/**
 * `o8 mission …` — mission lifecycle from the CLI.
 *
 * CLI-as-control-plane symmetry (Stage 1). These verbs lived
 * only in the operator MCP server; they are thin clients of the same gated
 * `/api/orchestrator/*` routes the MCP already calls, so the human operator
 * (headless) and a self-orchestrating agent both drive a mission from one
 * binary. No business logic here — fetch + JSON shape, per the CLI charter.
 *
 *   o8 mission create   --title "…" [--body "…"] [--repo <path>] [--runtime r]
 *                       [--model m] [--effort adaptive|low|medium|high|max|xhigh|ultra]
 *                       [--constraints "…"] [--sequential]
 *                       [--carrier native|openrouter|codex-subscription]
 *                       [--compare m1,m2] [--huddle] [--brain] [--number n]
 *                       [--read-only]
 *                       [--existingBranchPolicy auto|reset|continue|error]
 *                       [--quality-search-contract <json-file>]
 *   o8 mission dispatch [--mission <id>]
 *   o8 mission status   [--mission <id>] [--cost]
 *   o8 mission stop     --mission <id>
 *   o8 mission wait     [--mission <id>] [--packet <id>] [--timeout <ms|5m|90s>] [--poll ms]
 *   o8 mission tail     [--mission <id>] [--timeout <ms|5m|90s>] [--poll ms]
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../api.js';
import { fetchCorrelatedPacketMutation } from './packet/correlated-mutation.js';
import { resolveConfig } from '../config.js';
import {
  createTerminalStatusReporter,
  missionTailReport,
  packetStatusReport,
  packetTailReport,
  watchingStatusReport,
} from '../terminal-status.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../output.js';

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

interface CreateMissionResult {
  missionId: string;
  packets: Array<{ id: string; title: string; wave: number }>;
  branchPreparation?: unknown[];
}

interface DispatchMissionResult {
  queued?: Array<{ packetId: string; detail: string }>;
  initiated?: boolean;
  dispatched?: number;
  missionId?: string | null;
  inProgress?: boolean;
  status?: string;
  note?: string;
}

interface MissionStatusPacket {
  id: string;
  title?: string;
  blockedReason?: string | null;
  status?: string;
  wave?: number;
}

interface MissionStatusResult {
  missionId: string;
  packets?: MissionStatusPacket[];
  funnel?: {
    totalDurationMs?: number | null;
    terminalPacketCount?: number;
    attemptCount?: number;
    retryCount?: number;
    interventionCount?: number;
    recoveryEventCount?: number;
    strictAutonomousCloseCount?: number;
    governedAutonomousCloseCount?: number;
  } | null;
  [key: string]: unknown;
}

interface MissionStopResult {
  missionId: string;
  inProgress?: boolean;
  status?: string;
  note?: string;
  event?: {
    type?: string;
    recordedAt?: string;
  };
  packets: Array<{
    packetId: string;
    status: string;
    stoppedFrom?: string;
    laneId: string | null;
    note?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

type ExistingBranchPolicy = 'auto' | 'reset' | 'continue' | 'error';

const EXISTING_BRANCH_POLICY_ERROR =
  'existingBranchPolicy must be one of: auto, reset, continue, error.';

// Mirror of PACKET_ATTENTION_STATUSES in operator-handlers/mission.ts — the set
// `wait_for_mission_ready` treats as "needs the operator's attention". Kept in
// sync by the Stage-7 parity audit; duplicated here because the CLI is a
// standalone bundle that cannot import from `@/lib`. `blocked` is included
// (#1467): huddles, silent-exit parks, and dispatch failures all land there and
// none progress without a decision — a watcher that sleeps through them
// deadlocks against its own worker. Dependency-held packets stay `queued`.
const PACKET_TERMINAL_STATUSES = new Set(['awaiting_review', 'released', 'failed', 'archived', 'blocked']);

/**
 * Duration flag parser — accepts `90s` / `45m` / `2h` suffixes, or a bare
 * number in MILLISECONDS (backward compat). The bare-ms contract silently ate
 * watchers (live-hit 2026-07-12: `--timeout 3600` read as 3.6 SECONDS, the
 * watch died instantly, and the spawning agent never heard the packet hit
 * review). Cap 6h — long worker runs must be watchable end to end.
 */
const DURATION_CAP_MS = 6 * 60 * 60 * 1000;
export function parseDurationMs(raw: string | null | undefined, defaultMs: number): number {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return defaultMs;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) return defaultMs;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return defaultMs;
  const unit = (match[2] ?? 'ms').toLowerCase();
  const ms = unit === 'h' ? value * 3_600_000 : unit === 'm' ? value * 60_000 : unit === 's' ? value * 1000 : value;
  return Math.max(1000, Math.min(DURATION_CAP_MS, ms));
}

function flag(rest: string[], name: string): string | null {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === `--${name}`) return rest[i + 1] ?? '';
    if (tok.startsWith(`--${name}=`)) return tok.slice(name.length + 3);
  }
  return null;
}

function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(`--${name}`);
}

export function parseExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto' || value === 'reset' || value === 'continue' || value === 'error') {
    return value;
  }
  throw new CliError('invalid_args', EXISTING_BRANCH_POLICY_ERROR, EXIT.INVALID_ARGS);
}

/**
 * Concrete reasoning-effort pin. Mirrors THINKING_EFFORTS in
 * src/lib/orchestrator/thinking-effort.ts — the CLI is a standalone bundle that
 * cannot import from `@/lib`, so the vocabulary is duplicated like the other
 * mission enums. `adaptive` is the explicit reset-to-runtime-default value.
 */
export const MISSION_EFFORTS = ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'] as const;
export type MissionEffort = (typeof MISSION_EFFORTS)[number];
export const MISSION_EFFORT_ERROR = `--effort must be one of: ${MISSION_EFFORTS.join(', ')}.`;

export function parseMissionEffort(value: string | null | undefined): MissionEffort | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('--')) {
    throw new CliError(
      'invalid_args',
      '--effort requires a value.',
      EXIT.INVALID_ARGS,
      `Example: o8 mission create --title "…" --effort high (${MISSION_EFFORTS.join(', ')})`,
    );
  }
  if (!MISSION_EFFORTS.includes(trimmed as MissionEffort)) {
    throw new CliError('invalid_args', MISSION_EFFORT_ERROR, EXIT.INVALID_ARGS);
  }
  return trimmed as MissionEffort;
}

function missionEffortFlagValues(rest: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--effort') {
      values.push(rest[i + 1] ?? '');
      i += 1;
    } else if (tok.startsWith('--effort=')) {
      values.push(tok.slice('--effort='.length));
    }
  }
  return values;
}

/** Parse ALL --effort occurrences; conflicting repeats are rejected (not first-wins). */
export function parseMissionEffortArgs(rest: string[]): MissionEffort | undefined {
  const values = missionEffortFlagValues(rest);
  if (values.length === 0) return undefined;
  const parsed = values.map((value) => parseMissionEffort(value));
  const distinct = Array.from(new Set(parsed.filter((value): value is MissionEffort => Boolean(value))));
  if (distinct.length > 1) {
    throw new CliError(
      'invalid_args',
      `--effort was provided more than once with conflicting values (${distinct.join(', ')}).`,
      EXIT.INVALID_ARGS,
    );
  }
  return distinct[0];
}

export function parseMissionStopArgs(rest: string[]): { missionId: string; idempotencyKey?: string } {
  let missionId: string | null = null;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--mission') {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError('invalid_args', '--mission requires a value.', EXIT.INVALID_ARGS);
      }
      missionId = value;
      i += 1;
    } else if (tok.startsWith('--mission=')) {
      missionId = tok.slice('--mission='.length);
    } else if (tok === '--idempotency-key') {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError('invalid_args', '--idempotency-key requires a value.', EXIT.INVALID_ARGS);
      }
      idempotencyKey = value.trim();
      i += 1;
    } else if (tok.startsWith('--idempotency-key=')) {
      idempotencyKey = tok.slice('--idempotency-key='.length).trim();
    } else {
      throw new CliError(
        'invalid_args',
        `Unexpected mission stop argument: ${tok}`,
        EXIT.INVALID_ARGS,
        'usage: o8 mission stop --mission <missionId> [--idempotency-key <key>]',
      );
    }
  }
  if (!missionId?.trim()) {
    throw new CliError(
      'invalid_args',
      'o8 mission stop requires --mission.',
      EXIT.INVALID_ARGS,
      'Example: o8 mission stop --mission mission-abc123',
    );
  }
  return {
    missionId: missionId.trim(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string): string {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function unwrap<T>(payload: OperatorResponse<T> | null, fallback: string): T {
  if (!payload?.ok || payload.result === undefined) {
    throw new CliError('mission_failed', responseError(payload, fallback), EXIT.CONFLICT);
  }
  return payload.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packetSignature(packets: MissionStatusPacket[] | undefined): string {
  return (packets ?? []).map((p) => `${p.id}:${p.status ?? ''}`).sort().join('|');
}

async function runMissionCreate(mode: OutputMode, rest: string[]): Promise<number> {
  const title = flag(rest, 'title');
  if (!title?.trim()) {
    throw new CliError(
      'invalid_args',
      'o8 mission create requires --title.',
      EXIT.INVALID_ARGS,
      'Example: o8 mission create --title "Add a health route" --body "Create /api/health returning 200."',
    );
  }
  const repoPath = flag(rest, 'repo')?.trim() || process.cwd();
  const numberRaw = flag(rest, 'number');
  // Inline tasks need a positive issue number the service accepts. Synthesize a
  // high synthetic number when the caller didn't supply one (matches the
  // >=90001 convention used elsewhere for inline dispatch).
  const number = numberRaw && Number.isFinite(Number(numberRaw))
    ? Number(numberRaw)
    : 90001 + (Date.now() % 9000);

  const compareRaw = flag(rest, 'compare');
  const comparisonModels = compareRaw
    ? compareRaw.split(',').map((m) => m.trim()).filter(Boolean)
    : undefined;
  const existingBranchPolicy = parseExistingBranchPolicy(flag(rest, 'existingBranchPolicy'));
  const effort = parseMissionEffortArgs(rest);
  const qualitySearchContractPath = flag(rest, 'quality-search-contract')?.trim();
  if (qualitySearchContractPath && comparisonModels?.length) {
    throw new CliError('invalid_args', '--quality-search-contract cannot be combined with --compare.', EXIT.INVALID_ARGS);
  }
  if (qualitySearchContractPath && hasFlag(rest, 'huddle')) {
    throw new CliError('invalid_args', '--quality-search-contract cannot be combined with --huddle.', EXIT.INVALID_ARGS);
  }
  let qualitySearch: { taskContract: unknown } | undefined;
  if (qualitySearchContractPath) {
    try {
      qualitySearch = {
        taskContract: JSON.parse(readFileSync(resolve(qualitySearchContractPath), 'utf8')) as unknown,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('invalid_args', `Unable to read quality-search contract: ${message}`, EXIT.INVALID_ARGS);
    }
  }

  const body: Record<string, unknown> = {
    repoPath,
    issues: [{ number, title: title.trim(), body: flag(rest, 'body')?.trim() || '', url: '' }],
    dispatcher: { surface: 'operator', id: 'cli' },
    launchContext: {
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      ...(hasFlag(rest, 'read-only') ? { workMode: 'read-only' } : {}),
      caller: flag(rest, 'caller')?.trim() || 'terminal',
    },
  };
  const runtime = flag(rest, 'runtime');
  if (runtime) body.runtime = runtime;
  const model = flag(rest, 'model');
  if (model) body.model = model;
  if (effort) body.requestedEffort = effort;
  const carrier = flag(rest, 'carrier');
  if (carrier) body.carrier = carrier;
  const constraints = flag(rest, 'constraints');
  if (constraints) body.constraints = constraints;
  if (hasFlag(rest, 'sequential')) body.sequential = true;
  if (hasFlag(rest, 'huddle')) body.huddle = true;
  if (hasFlag(rest, 'brain')) body.useBrain = true;
  if (comparisonModels && comparisonModels.length > 0) body.comparisonModels = comparisonModels;
  if (existingBranchPolicy) body.existingBranchPolicy = existingBranchPolicy;
  if (qualitySearch) body.qualitySearch = qualitySearch;
  if (hasFlag(rest, 'dispatch')) body.dispatchOnCreate = true;
  body.clientMutationId = flag(rest, 'idempotency-key')?.trim() || randomUUID();

  const cfg = resolveConfig();
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<CreateMissionResult & {
    inProgress?: boolean;
    status?: string;
    note?: string;
  }>>(cfg, '/api/orchestrator/create-mission', body, { timeoutMs: SLOW_MUTATION_TIMEOUT_MS });
  const result = unwrap(res.data, 'Mission creation was rejected.');

  let dispatch: DispatchMissionResult | null = null;
  if (hasFlag(rest, 'dispatch')) {
    const dispatchResponse = await fetchCorrelatedPacketMutation<OperatorResponse<DispatchMissionResult>>(
      cfg,
      '/api/orchestrator/dispatch',
      { missionId: result.missionId, wait: false, idempotencyKey: randomUUID() },
    );
    dispatch = unwrap(dispatchResponse.data, 'Mission dispatch was rejected.');
  }

  const payload = { schema: 'o8/cli/mission.create/v1', mission: result, ...(dispatch ? { dispatch } : {}) };
  if (mode.human) {
    printHumanHeading('mission create');
    printHumanKv([
      ['mission', result.missionId],
      ['packets', String(result.packets.length)],
      ...(dispatch ? [['dispatch', dispatch.initiated === false ? 'not initiated' : 'initiated']] as Array<[string, string]> : []),
      ...result.packets.map((p) => [`  · ${p.id}`, `${p.title} (wave ${p.wave})`] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionDispatch(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  // Default async: launching workers (Codex spawn + worktrees) takes minutes;
  // returning once dispatch is initiated keeps the CLI snappy. `--wait` blocks
  // for the full launch + the dispatched-count. Either way, `o8 mission status`
  // / `o8 mission wait` track progress.
  const wait = hasFlag(rest, 'wait');
  const cfg = resolveConfig();
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<DispatchMissionResult>>(
    cfg,
    '/api/orchestrator/dispatch',
    { ...(missionId ? { missionId } : {}), wait, idempotencyKey: randomUUID() },
    { timeoutMs: wait ? SLOW_MUTATION_TIMEOUT_MS : undefined, acceptQueuedAdmission: true },
  );
  const result = unwrap(res.data, 'Mission dispatch was rejected.');
  const inProgress = res.status === 202 || result.inProgress === true || result.status === 'in_progress';
  if (!wait && !inProgress && (result.initiated !== true || !result.missionId?.trim())) {
    throw new CliError(
      'dispatch_not_initiated',
      'No mission was dispatched. Create or select a mission first.',
      EXIT.NOT_FOUND,
    );
  }

  const payload = { schema: 'o8/cli/mission.dispatch/v1', inProgress, dispatch: result };
  if (mode.human) {
    printHumanHeading('mission dispatch');
    printHumanKv([
      ['mission', result.missionId ?? missionId ?? '(active)'],
      [
        'result',
        inProgress
          ? 'already in progress (not dispatched twice)'
          : result.status === 'queued'
            ? `queued (${result.queued?.length ?? 0} packet(s)); ${wait ? 'returned before launch' : 'admitted, awaiting launch'}`
          : wait
            ? `dispatched ${result.dispatched ?? '?'} packet(s)`
            : 'initiated (track: o8 mission status)',
      ],
      ...(result.queued ?? []).map((entry) => [entry.packetId, entry.detail] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }

  // --watch: dispatch-and-notify in ONE command (Q ruling 2026-07-12: the
  // spawner must hear the packet hit review INSTANTLY, not via hand-rolled
  // pollers). Blocks until any packet reaches a terminal/review status, then
  // exits — a backgrounded `dispatch --watch` becomes the notification. Long
  // default (2h) so a real worker run can't outlive its watcher silently.
  if (hasFlag(rest, 'watch')) {
    const watchMs = parseDurationMs(flag(rest, 'timeout'), 2 * 60 * 60 * 1000);
    const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 5000);
    const deadline = Date.now() + watchMs;
    let terminal: { id: string; status?: string; title?: string } | null = null;
    const tabStatus = createTerminalStatusReporter(mode);
    while (Date.now() < deadline) {
      const snapshot = await fetchStatus(missionId, false).catch((error: unknown) => {
        tabStatus.report({ state: 'clear' });
        throw error;
      });
      terminal = (snapshot.packets ?? []).find(
        (p) => typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
      ) ?? null;
      if (terminal) break;
      tabStatus.report(watchingStatusReport(snapshot.packets ?? []));
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    const watchPayload = {
      schema: 'o8/cli/mission.dispatch.watch/v1',
      wakeReason: terminal ? 'packet-terminal' : 'timeout',
      packetId: terminal?.id ?? null,
      status: terminal?.status ?? null,
      title: terminal?.title ?? null,
    };
    if (mode.human) {
      printHumanKv([
        ['watch', terminal ? `${terminal.id} → ${terminal.status}` : 'timeout — still running'],
      ]);
    } else {
      printJson(watchPayload);
    }
    // Printed last so a finished or failed record stays in the tab after exit.
    tabStatus.report(packetStatusReport(terminal?.status, terminal?.title) ?? { state: 'clear' });
  }
  return 0;
}

async function fetchStatus(
  missionId: string | undefined,
  includeCost: boolean,
  includeTiming = false,
): Promise<MissionStatusResult> {
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<MissionStatusResult>>(cfg, '/api/orchestrator/status', {
    query: {
      ...(missionId ? { missionId } : {}),
      ...(includeCost ? { includeCost: 'true' } : {}),
      ...(includeTiming ? { includeTiming: 'true' } : {}),
    },
  });
  return unwrap(res.data, 'Unable to read mission status.');
}

function formatReceiptDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'in progress';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

async function runMissionStatus(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const result = await fetchStatus(missionId, hasFlag(rest, 'cost'), true);

  const payload = { schema: 'o8/cli/mission.status/v1', status: result };
  if (mode.human) {
    printHumanHeading('mission status');
    printHumanKv([
      ['mission', result.missionId || '(none)'],
      ...(result.funnel ? [
        ['receipt', `${formatReceiptDuration(result.funnel.totalDurationMs)} · ${result.funnel.terminalPacketCount ?? 0}/${result.packets?.length ?? 0} terminal`],
        ['attempts', `${result.funnel.attemptCount ?? 0} total · ${result.funnel.retryCount ?? 0} ${(result.funnel.retryCount ?? 0) === 1 ? 'retry' : 'retries'}`],
        ['control', `${result.funnel.interventionCount ?? 0} interventions · ${result.funnel.recoveryEventCount ?? 0} recoveries`],
        ['autonomy', `${result.funnel.strictAutonomousCloseCount ?? 0} strict · ${result.funnel.governedAutonomousCloseCount ?? 0} approval-only`],
      ] as Array<[string, string]> : []),
      ...(result.packets ?? []).map((p) => [`  · ${p.id}`, `${p.status ?? '?'} — ${p.title ?? ''}${p.blockedReason ? ` — ${p.blockedReason}` : ''}`] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionStop(mode: OutputMode, rest: string[]): Promise<number> {
  const { missionId, idempotencyKey } = parseMissionStopArgs(rest);
  const cfg = resolveConfig();
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<MissionStopResult>>(
    cfg,
    '/api/orchestrator/stop-mission',
    { missionId, idempotencyKey: idempotencyKey ?? randomUUID() },
    {
      timeoutMs: SLOW_MUTATION_TIMEOUT_MS,
      allowConflict: true,
    },
  );
  if (res.status === 409 && res.data?.ok === false) {
    throw new CliError(
      'conflict',
      responseError(res.data, 'Mission stop was incomplete.'),
      EXIT.CONFLICT,
    );
  }
  const result = unwrap(res.data, 'Mission stop was rejected.');

  const payload = { schema: 'o8/cli/mission.stop/v1', mission: result };
  if (mode.human) {
    printHumanHeading('mission stop');
    printHumanKv([
      ['mission', result.missionId],
      ['packets', String(result.packets.length)],
      ...result.packets.map((item) => [
        `  · ${item.packetId}`,
        `${item.status}${item.stoppedFrom ? ` · from ${item.stoppedFrom}` : ''}${item.laneId ? ` · ${item.laneId}` : ''}${item.note ? ` · ${item.note}` : ''}`,
      ] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runMissionWait(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const packetFilter = flag(rest, 'packet')?.trim() || null;
  const timeoutMs = parseDurationMs(flag(rest, 'timeout'), 10 * 60 * 1000);
  const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 3000);

  const terminalOf = (s: MissionStatusResult) => (s.packets ?? []).find(
    (p) => (!packetFilter || p.id === packetFilter) && typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
  ) ?? null;

  const tabStatus = createTerminalStatusReporter(mode);
  const baseline = await fetchStatus(missionId, false);
  let snapshot = baseline;
  let wakeReason: 'already-terminal' | 'state-change' | 'timeout' = 'timeout';
  const baselineTerminal = terminalOf(baseline);
  if (baselineTerminal) {
    wakeReason = 'already-terminal';
  } else {
    const baselineSig = packetSignature(baseline.packets);
    const deadline = Date.now() + timeoutMs;
    tabStatus.report(watchingStatusReport(
      (baseline.packets ?? []).filter((p) => !packetFilter || p.id === packetFilter),
    ));
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      const next = await fetchStatus(missionId, false).catch((error: unknown) => {
        tabStatus.report({ state: 'clear' });
        throw error;
      });
      snapshot = next;
      if (terminalOf(next) || packetSignature(next.packets) !== baselineSig) {
        wakeReason = 'state-change';
        break;
      }
    }
  }

  const terminalPacket = terminalOf(snapshot);
  const payload = {
    schema: 'o8/cli/mission.wait/v1',
    wakeReason,
    terminalPacketId: terminalPacket?.id ?? null,
    status: snapshot,
  };
  if (mode.human) {
    printHumanHeading('mission wait');
    printHumanKv([
      ['mission', snapshot.missionId || '(none)'],
      ['wake', wakeReason],
      ['terminal packet', terminalPacket?.id ?? '(none)'],
      ...(snapshot.packets ?? []).map((p) => [`  · ${p.id}`, p.status ?? '?'] as [string, string]),
    ]);
  } else {
    printJson(payload);
  }
  // Printed last so a finished or failed record stays in the tab after exit.
  tabStatus.report(packetStatusReport(terminalPacket?.status, terminalPacket?.title) ?? { state: 'clear' });
  // Timeout is a soft outcome, not an error — exit 0 with wakeReason so the
  // caller branches on the field, not the code.
  return 0;
}

async function runMissionTail(mode: OutputMode, rest: string[]): Promise<number> {
  const missionId = flag(rest, 'mission')?.trim() || undefined;
  const timeoutMs = parseDurationMs(flag(rest, 'timeout'), 10 * 60 * 1000);
  const pollMs = Math.max(1000, Number(flag(rest, 'poll')) || 3000);

  const deadline = Date.now() + timeoutMs;
  const lastStatus = new Map<string, string>();
  let allTerminal = false;

  const emit = (event: Record<string, unknown>) => {
    if (mode.human) {
      process.stdout.write(`${String(event.packetId)}  ${String(event.from ?? '∅')} → ${String(event.status)}\n`);
    } else {
      printJson({ schema: 'o8/cli/mission.tail.event/v1', ...event });
    }
  };

  const tabStatus = createTerminalStatusReporter(mode);
  while (Date.now() < deadline && !allTerminal) {
    const snapshot = await fetchStatus(missionId, false).catch((error: unknown) => {
      tabStatus.report({ state: 'clear' });
      throw error;
    });
    const packets = snapshot.packets ?? [];
    for (const p of packets) {
      const prev = lastStatus.get(p.id);
      const cur = p.status ?? '?';
      if (prev !== cur) {
        emit({ packetId: p.id, from: prev ?? null, status: cur, title: p.title ?? '' });
        lastStatus.set(p.id, cur);
      }
      tabStatus.report(packetTailReport(p));
    }
    tabStatus.report(missionTailReport(packets));
    allTerminal = packets.length > 0 && packets.every(
      (p) => typeof p.status === 'string' && PACKET_TERMINAL_STATUSES.has(p.status),
    );
    if (allTerminal) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  if (!mode.human) {
    printJson({ schema: 'o8/cli/mission.tail/v1', done: allTerminal, reason: allTerminal ? 'all-terminal' : 'timeout' });
  }
  // A timed-out tail clears its marks; a finished one leaves them in the tab.
  if (!allTerminal) tabStatus.report({ state: 'clear' });
  return 0;
}

export async function runMission(mode: OutputMode, secondary: string | undefined, rest: string[]): Promise<number> {
  switch (secondary) {
    case 'create':
      return runMissionCreate(mode, rest);
    case 'dispatch':
      return runMissionDispatch(mode, rest);
    case 'status':
      return runMissionStatus(mode, rest);
    case 'stop':
      return runMissionStop(mode, rest);
    case 'wait':
      return runMissionWait(mode, rest);
    case 'tail':
      return runMissionTail(mode, rest);
    default:
      throw new CliError(
        'unknown_mission_subcommand',
        `Unknown mission subcommand: ${secondary ?? '(none)'}`,
        EXIT.INVALID_ARGS,
        'Subcommands: create | dispatch | status | stop | wait | tail. Run `o8 --help`.',
      );
  }
}
