/**
 * Gemini owned-session adapter.
 *
 * Mirrors `src/lib/codex/owned.ts` in shape: a thin Gemini-specific adapter
 * stacked on top of the generic owned-session primitive
 * (`@/lib/runtimes/shared/owned-session`). The heavy lifting (spawn, refresh,
 * auto-retry, fleet cache, review packet assembly) lives in the shared store;
 * this file only knows the Gemini CLI-specific bits.
 *
 * What's Gemini-specific and lives here:
 *   - launchArgs / resumeArgs (Gemini CLI headless flags: `-p`, `--resume`,
 *     `--output-format stream-json`, `--yolo`)
 *   - parseRunLog (Gemini JSONL events: init, message, tool_use, tool_result,
 *     result)
 *   - parseRunEvidence (assistant summary + tool-call evidence from the stream)
 *   - stderr noise patterns (experimental-model warnings, session-save info)
 *
 * Surfaces `gemini-owned:<id>` ids; data dir is `~/.o8/owned-gemini/`.
 */

import path from 'node:path';
import type { RuntimeReviewCommandEvidence } from '@/lib/fleet/types';
import {
  compactText,
  createOwnedSessionStore,
  previewText,
  type OwnedRunEvidence,
  type OwnedRunOutcome,
  type OwnedRunRecord,
  type OwnedRuntimeAdapter,
  type OwnedTailEntry,
  type ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Gemini-specific public types ─────────────────────────────────────────────

export type OwnedGeminiLaunchRequest = {
  cwd: string;
  prompt: string;
  promptMemoryRevision?: string;
  clientMutationId?: string;
  model?: string;
  laneId?: string;
  packetId?: string;
};

export type OwnedGeminiLaunchResponse = {
  ok: boolean;
  runtime: 'gemini';
  surfaceId: string;
  note: string;
  sideEffect?: 'none' | 'unknown';
};

type OwnedReviewDisposition = 'watching' | 'resolved';

// ── Small JSON helpers (mirrored from codex/owned.ts) ────────────────────────

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = safeObject(item);
        if (!record) return '';
        return readStringField(record, 'text', 'message') ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  const record = safeObject(value);
  if (!record) return '';
  return readStringField(record, 'text', 'message', 'output') ?? '';
}

function formatClockLocal(timestampIso?: string) {
  if (!timestampIso) return undefined;
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function humanizeToolName(value?: string) {
  const raw = (value ?? '').trim();
  if (!raw) return 'tool';
  return raw.replace(/[_-]+/g, ' ').trim();
}

function summarizeToolInput(toolName: string, rawInput: unknown, directPath?: string): string {
  const normalizedName = toolName.trim();
  const input = safeObject(rawInput);
  const inputPath = directPath
    ?? readStringField(input, 'path', 'file_path', 'filePath', 'target_file', 'filename', 'fileName');
  const command = readStringField(input, 'command', 'cmd');

  if (command && (normalizedName === 'run_shell_command' || normalizedName === 'shell' || normalizedName === 'ShellCommand')) {
    return `Run ${compactText(command, 180)}`;
  }

  if (inputPath) {
    const pathLabel = compactText(inputPath, 180);
    if (normalizedName === 'read_file' || normalizedName === 'ReadFile') return `Read ${pathLabel}`;
    if (normalizedName === 'write_file' || normalizedName === 'WriteFile') return `Write ${pathLabel}`;
    if (normalizedName === 'edit' || normalizedName === 'Edit') return `Edit ${pathLabel}`;
    if (normalizedName === 'ReadFolder' || normalizedName === 'read_folder') return `Inspect folder ${pathLabel}`;
  }

  if (normalizedName === 'FindFiles') return 'Find files';
  if (normalizedName === 'SearchText') return 'Search text';
  if (normalizedName === 'Codebase_Investigator') return 'Investigate codebase';
  if (normalizedName === 'WebFetch') return 'Fetch web resource';
  if (normalizedName === 'GoogleSearch') return 'Google search';
  if (normalizedName === 'SaveMemory') return 'Save memory note';

  // Fallback — include a short stringified input preview when we have one.
  const inputPreview = rawInput && typeof rawInput === 'object'
    ? compactText(JSON.stringify(rawInput), 180)
    : rawInput != null
      ? compactText(String(rawInput), 180)
      : '';
  const humanName = humanizeToolName(normalizedName);
  return inputPreview ? `Use ${humanName}: ${inputPreview}` : `Use ${humanName}`;
}

// ── Gemini CLI argv builders ─────────────────────────────────────────────────
//
// `--yolo` is an undocumented flag that auto-accepts tool-use approval prompts.
// We rely on it for headless autonomous dispatch. If Gemini CLI ever removes
// it, fall back to a wrapper that pipes "y\n" via stdin. See Wave 2c research
// notes for context.

function geminiLaunchArgs(ctx: { cwd: string; prompt: string; model?: string }): string[] {
  // Note: Gemini CLI doesn't take --cwd; the owned-session store spawns with
  // cwd set on the child process options, so the prompt + working dir still
  // line up correctly.
  return [
    '-p', ctx.prompt,
    '--output-format', 'stream-json',
    '--yolo',
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

function geminiResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  return [
    '--resume', ctx.threadId,
    '-p', ctx.prompt,
    '--output-format', 'stream-json',
    '--yolo',
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

// ── Gemini JSONL stdout parser ───────────────────────────────────────────────
//
// Expected event shapes (Wave 1 research, confirmed Apr 2026):
//   { type: 'init',        sessionId: '<uuid>' }
//   { type: 'message',     content: '<text>' }
//   { type: 'tool_use',    tool: '<name>', path?: '<path>', input?: {...} }
//   { type: 'tool_result', output: '<text>' }
//   { type: 'result',      response: '<text>', stats?: { duration, turns, toolCalls,
//                                                         inputTokens, outputTokens, ... } }
//
// A missing `result` event before exit means the run failed. Exit code 53
// (turn-limit) + 429-ish rate limit lines get surfaced as `failed`.

function detectRateLimited(raw: string): boolean {
  // Gemini free tier: 429 + "Quota exceeded" — also trap the "switched to
  // gemini-2.5-flash" fallback message that the CLI emits when Pro throttles.
  return /\b429\b|quota exceeded|rate.?limit|switched to gemini-2\.5-flash/i.test(raw);
}

function geminiParseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const entries: OwnedTailEntry[] = [
    {
      id: `${run.id}:prompt`,
      kind: 'event',
      label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
      text: compactText(run.prompt, 400),
      timestamp: run.startedAt,
      timestampLabel: formatClockLocal(run.startedAt),
    },
  ];

  let threadId: string | undefined;
  let completedTurn = false;
  let noiseIndex = 0;

  const fallbackIso = run.finishedAt ?? run.startedAt;
  const fallbackLabel = formatClockLocal(fallbackIso);

  for (const [lineIndex, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) {
      // Gemini can interleave non-JSON banner text (experimental model warnings,
      // "Session saved to …"). Keep them as low-priority noise entries so the
      // tail is still informative without exploding the parser.
      entries.push({
        id: `${run.id}:noise:${(noiseIndex += 1)}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 400),
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Swallow parse errors — Gemini may emit some non-JSON noise during
      // session startup or shutdown.
      continue;
    }

    const type = String(parsed.type ?? '').toLowerCase();

    if (type === 'init') {
      const sid = readStringField(parsed, 'sessionId', 'session_id', 'thread_id');
      if (sid) threadId = sid;
      entries.push({
        id: `${run.id}:init:${entries.length}`,
        kind: 'event',
        label: 'Run started',
        text: run.mode === 'launch'
          ? 'Owned Gemini run launched from o8.'
          : 'Owned Gemini session resumed from o8.',
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
      continue;
    }

    if (type === 'message') {
      const role = String(parsed.role ?? '').toLowerCase();
      // Skip user-role messages — they're the prompt echo that Gemini CLI
      // emits at the start of each run. The prompt is already surfaced via
      // group.prompt (from the owned-session-store) and as the
      // PacketHeaderCard. Letting it in here would duplicate the prompt
      // as a second bubble below the card.
      if (role === 'user' || role === 'operator') {
        continue;
      }
      const text = compactText(
        readStringField(parsed, 'content', 'text', 'message') ?? extractText(parsed.content),
        500,
      );
      if (text) {
        entries.push({
          id: `${run.id}:message:${lineIndex}`,
          kind: 'message',
          label: 'Assistant',
          text,
          timestamp: fallbackIso,
          timestampLabel: fallbackLabel,
        });
      }
      continue;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      const toolName = readStringField(parsed, 'tool', 'name', 'tool_name') ?? 'tool';
      const toolPath = readStringField(parsed, 'path', 'file_path', 'filePath');
      const toolInput = parsed.input ?? parsed.arguments ?? parsed;
      entries.push({
        id: `${run.id}:tool:${readStringField(parsed, 'id', 'call_id') ?? lineIndex}`,
        kind: 'tool',
        label: toolName,
        text: summarizeToolInput(toolName, toolInput, toolPath),
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
      continue;
    }

    if (type === 'tool_result' || type === 'tool_output') {
      const output = compactText(readStringField(parsed, 'output', 'result') ?? extractText(parsed.output), 500);
      if (output) {
        entries.push({
          id: `${run.id}:tool-output:${readStringField(parsed, 'id', 'call_id') ?? lineIndex}`,
          kind: 'tool-output',
          label: 'Tool output',
          text: output,
          timestamp: fallbackIso,
          timestampLabel: fallbackLabel,
        });
      }
      continue;
    }

    if (type === 'result') {
      completedTurn = true;
      const response = readStringField(parsed, 'response', 'text', 'message');
      if (response) {
        entries.push({
          id: `${run.id}:result-text:${entries.length}`,
          kind: 'message',
          label: 'Assistant',
          text: compactText(response, 500),
          timestamp: fallbackIso,
          timestampLabel: fallbackLabel,
        });
      }
      const stats = safeObject(parsed.stats) ?? safeObject(parsed.usage);
      const usageBits: string[] = [];
      if (stats) {
        const inputTokens = stats.input_tokens ?? stats.inputTokens ?? stats.promptTokenCount;
        const outputTokens = stats.output_tokens ?? stats.outputTokens ?? stats.candidatesTokenCount;
        const turns = stats.turns ?? stats.turn_count;
        const toolCalls = stats.toolCalls ?? stats.tool_calls;
        if (typeof inputTokens === 'number') usageBits.push(`${inputTokens} in`);
        if (typeof outputTokens === 'number') usageBits.push(`${outputTokens} out`);
        if (typeof turns === 'number') usageBits.push(`${turns} turns`);
        if (typeof toolCalls === 'number') usageBits.push(`${toolCalls} tools`);
      }
      entries.push({
        id: `${run.id}:result:${entries.length}`,
        kind: 'event',
        label: 'Turn completed',
        text: usageBits.length ? `Usage • ${usageBits.join(' • ')}` : 'Run completed.',
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
      continue;
    }

    if (type === 'error') {
      entries.push({
        id: `${run.id}:error:${lineIndex}`,
        kind: 'event',
        label: 'Error',
        text: compactText(readStringField(parsed, 'message', 'error', 'text') ?? trimmed, 500),
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
      continue;
    }
  }

  // Outcome resolution:
  //   - completed `result` event → finished
  //   - still running (no finishedAt) → running
  //   - explicit interrupt → interrupted
  //   - otherwise → failed (covers turn-limit exit 53 and rate-limit 429)
  let outcome: OwnedRunOutcome = run.outcome;
  if (run.outcome === 'running') {
    if (completedTurn) {
      outcome = 'finished';
    } else if (run.interruptRequestedAt) {
      outcome = 'interrupted';
    }
  }

  // If the process exited without a `result` event, flip to failed. Surface
  // a friendly note for the common rate-limit / turn-limit cases so operators
  // know whether to switch model or retry.
  if (outcome === 'running' && run.finishedAt && !completedTurn) {
    outcome = 'failed';
    if (detectRateLimited(raw)) {
      entries.push({
        id: `${run.id}:rate-limit:${entries.length}`,
        kind: 'event',
        label: 'Rate limited',
        text: 'Gemini rate-limited this run. Switch to paid Gemini API or use gemini-2.5-flash.',
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
    } else if (!raw.trim()) {
      // Silent exit: no stdout and no stderr. Most commonly happens when
      // many Gemini 3.1 Pro calls land concurrently and upstream drops one
      // without emitting a 429 line. Surface explicitly so operators know
      // to retry or reduce parallel load rather than staring at an empty tail.
      entries.push({
        id: `${run.id}:silent-exit:${entries.length}`,
        kind: 'event',
        label: 'Silent exit',
        text: 'Gemini exited without emitting any output. Likely a transient upstream drop (parallel-dispatch rate-limit, auth handshake, or network hiccup). Retry; if it persists, reduce concurrent Gemini dispatches.',
        timestamp: fallbackIso,
        timestampLabel: fallbackLabel,
      });
    }
  }

  // Coalesce consecutive assistant message chunks into a single bubble.
  // Gemini streams text in delta fragments ({ type:'message', delta:true })
  // and the parser produces one entry per fragment. Without merging, the
  // transcript renders 5+ avatar-stamped bubbles per turn — ugly + breaks
  // the <self-review> block across bubbles. Also strips the machine-readable
  // <self-review>...</self-review> block since operators don't need to see
  // JSON validation markup in the chat transcript.
  const coalesced: OwnedTailEntry[] = [];
  for (const entry of entries) {
    const prev = coalesced[coalesced.length - 1];
    const isMergeable = entry.kind === 'message' && entry.label === 'Assistant';
    if (isMergeable && prev && prev.kind === 'message' && prev.label === 'Assistant') {
      // Append to the prior bubble; preserve its id/timestamp. Join with a
      // non-breaking space only if the chunk doesn't already end in whitespace
      // — Gemini emits deltas mid-word sometimes.
      const sep = /\s$/.test(prev.text) || /^[\s.,!?:;)]/.test(entry.text) ? '' : '';
      prev.text = `${prev.text}${sep}${entry.text}`;
      continue;
    }
    coalesced.push({ ...entry });
  }
  // Strip the self-review block from each assistant bubble — keep surrounding prose.
  const SELF_REVIEW_RE = /\s*<self-review>[\s\S]*?<\/self-review>\s*/gi;
  for (const entry of coalesced) {
    if (entry.kind === 'message' && entry.label === 'Assistant') {
      entry.text = entry.text.replace(SELF_REVIEW_RE, ' ').replace(/\s+$/, '').trim();
    }
  }

  return {
    threadId,
    entries: coalesced.filter((entry) => !(entry.kind === 'message' && !entry.text.trim())),
    outcome,
    completedTurn,
  };
}

// ── Review-evidence parser ───────────────────────────────────────────────────

function geminiParseRunEvidence(raw: string, run: OwnedRunRecord, resolvedOutcome: OwnedRunOutcome): OwnedRunEvidence {
  let assistantSummary: string | undefined;
  const commands: RuntimeReviewCommandEvidence[] = [];
  const finalOutcome = resolvedOutcome ?? run.outcome;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(parsed.type ?? '').toLowerCase();

    if (type === 'message') {
      const text = readStringField(parsed, 'content', 'text', 'message');
      if (text) {
        assistantSummary = previewText(text, 220) ?? assistantSummary;
      }
      continue;
    }

    if (type === 'result') {
      const response = readStringField(parsed, 'response', 'text', 'message');
      if (response) {
        assistantSummary = previewText(response, 220) ?? assistantSummary;
      }
      continue;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      const toolName = readStringField(parsed, 'tool', 'name') ?? 'tool';
      if (toolName !== 'run_shell_command' && toolName !== 'shell' && toolName !== 'ShellCommand') {
        continue;
      }
      const input = safeObject(parsed.input) ?? safeObject(parsed.arguments);
      const command = readStringField(input, 'command', 'cmd') ?? readStringField(parsed, 'command', 'cmd');
      const id = readStringField(parsed, 'id', 'call_id') ?? `${run.id}:${commands.length}`;
      commands.push({
        id,
        command: previewText(command ?? 'command', 180) ?? 'command',
        status: finalOutcome === 'interrupted' ? 'interrupted' : 'running',
        exitCode: null,
        outputPreview: undefined,
      });
      continue;
    }

    if (type === 'tool_result' || type === 'tool_output') {
      const id = readStringField(parsed, 'id', 'call_id');
      if (!id) continue;
      const match = commands.find((entry) => entry.id === id);
      if (!match) continue;
      const output = readStringField(parsed, 'output', 'result');
      const exitCode = typeof parsed.exit_code === 'number' ? (parsed.exit_code as number) : null;
      match.status = finalOutcome === 'interrupted'
        ? 'interrupted'
        : exitCode != null && exitCode !== 0
          ? 'failed'
          : 'completed';
      match.exitCode = exitCode;
      match.outputPreview = previewText(output ?? '', 260);
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

/**
 * Patterns in Gemini CLI stderr that are non-fatal noise. These get filtered
 * before the shared outcome-deriver scans for "panic/fatal/error" strings.
 */
const GEMINI_STDERR_NOISE_PATTERNS: RegExp[] = [
  /warning:\s*using experimental model/i,
  /\[info\]\s+session saved to/i,
  /\[info\]\s+loaded.*mcp server/i,
  /\[debug\]/i,
  /updating to gemini cli/i,
];

// Fallback cascade for Gemini when a model hits its daily quota. Walks the
// list top → bottom; each retry swaps to the next model and emits a
// runtime_fallback notification so the chat pane can pill the transition.
// Keep in sync with GEMINI_CLI_MODELS ordering in constants.ts.
const GEMINI_FALLBACK_CASCADE: string[] = [
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

function chooseNextGeminiModel(currentModel: string | undefined): string | null {
  const current = currentModel || GEMINI_FALLBACK_CASCADE[0];
  const idx = GEMINI_FALLBACK_CASCADE.indexOf(current);
  if (idx === -1) return GEMINI_FALLBACK_CASCADE[0];
  return GEMINI_FALLBACK_CASCADE[idx + 1] ?? null;
}

function describeGeminiModel(id: string): string {
  const labels: Record<string, string> = {
    'gemini-3-pro-preview': 'Gemini 3 Pro',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-pro-latest': 'Gemini Pro (latest)',
    'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite',
  };
  return labels[id] ?? id;
}

const geminiAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'gemini',
  // Prefix is load-bearing: drives session routing in the runtime registry.
  surfaceIdPrefix: 'gemini-owned:',
  rootEnvVar: 'O8_OWNED_GEMINI_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-gemini'),
  binaryName: 'gemini',
  binaryEnvOverride: 'O8_GEMINI_BIN',
  humanLabel: 'Owned Gemini',
  squadShortName: 'Gemini',
  sessionIdPrefix: 'gemini-owned-',
  launchArgs: geminiLaunchArgs,
  resumeArgs: geminiResumeArgs,
  parseRunLog: geminiParseRunLog,
  parseRunEvidence: geminiParseRunEvidence,
  stderrNoise: GEMINI_STDERR_NOISE_PATTERNS,
  retryDelayMs: 5_000,
  launchGroupLabel: 'Launch turn',
  resumeGroupLabel: 'Resume turn',
  chooseRetryModel: ({ failedRunRaw, currentModel }) => {
    // Only cascade on quota / rate-limit. Other failures (crashes, auth,
    // tool errors) should surface to the operator — keep the same model so
    // the retry reveals the real cause, not a false "switched models" signal.
    const quotaSignals = /exhausted your daily quota|quota exceeded|RESOURCE_EXHAUSTED|\b429\b|TerminalQuotaError/i;
    if (!quotaSignals.test(failedRunRaw)) return null;
    const nextModel = chooseNextGeminiModel(currentModel);
    if (!nextModel) return null;
    const fromLabel = describeGeminiModel(currentModel ?? GEMINI_FALLBACK_CASCADE[0]);
    const toLabel = describeGeminiModel(nextModel);
    return {
      nextModel,
      reason: `${fromLabel} hit its daily quota — retrying on ${toLabel}.`,
    };
  },
};

const geminiStore = createOwnedSessionStore(geminiAdapter);

// ── Public API (parallels the Codex wrappers — same shapes, gemini labels) ──

export function invalidateOwnedGeminiFleetCache(): void {
  geminiStore.invalidateFleetCache();
}

export async function archiveOwnedGeminiSession(surfaceId: string) {
  return geminiStore.archiveSession(surfaceId);
}

export async function ownedGeminiSessionState(surfaceId: string) {
  return geminiStore.sessionState(surfaceId);
}

export async function sweepOrphanedGeminiSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
  return geminiStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs);
}

export async function launchOwnedGeminiSession(
  request: OwnedGeminiLaunchRequest,
): Promise<OwnedGeminiLaunchResponse> {
  const result = await geminiStore.launch(request);
  return {
    ok: result.ok,
    runtime: 'gemini',
    surfaceId: result.surfaceId,
    note: result.note,
    sideEffect: result.sideEffect,
  };
}

export async function continueOwnedGeminiSession(surfaceId: string, prompt: string) {
  return geminiStore.resume(surfaceId, prompt);
}

export async function interruptOwnedGeminiSession(surfaceId: string) {
  // SIGINT to the child is best-effort. The underlying store sends SIGINT to
  // the process group (or the tmux bridge). Mid-tool file writes CAN leave
  // partial changes on disk — that risk is called out in the review packet
  // when the outcome is 'interrupted'.
  console.log(`[owned-gemini] Interrupting ${surfaceId} — mid-flight interrupt may leave partial changes.`);
  return geminiStore.interrupt(surfaceId);
}

export async function setOwnedGeminiReviewDisposition(
  surfaceId: string,
  disposition: OwnedReviewDisposition,
) {
  return geminiStore.setReviewDisposition(surfaceId, disposition);
}

export async function getOwnedGeminiTelemetrySources(surfaceId: string) {
  return geminiStore.getTelemetrySources(surfaceId);
}

export async function getOwnedGeminiRuntimeTail(surfaceId: string, limit?: number) {
  return geminiStore.getRuntimeTail(surfaceId, limit);
}

export async function getOwnedGeminiReviewPacket(surfaceId: string) {
  return geminiStore.getReviewPacket(surfaceId);
}

export async function getOwnedGeminiFleetAdditions(options: { fresh?: boolean } = {}) {
  return geminiStore.getFleetAdditions(options);
}
