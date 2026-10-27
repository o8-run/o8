import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { spawn } from '@/lib/providers/child-process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { MODEL_IDS } from '@/lib/models';
import { getDataDir } from '@/lib/data-dir-migration';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { getCanonicalChatHistoryPath, persistCanonicalChatHistoryRecordUnlocked, readPersistedLlmChat, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { logUsage } from '@/lib/db/usage';
import { scoreCompactionSegment } from '@/lib/orchestrator/compaction-scorer';
import { clipCompactionText, compactionEntryText } from './compaction-text';
import { withLiveCompaction } from './live-compaction';
const ARCHIVE_DIR = path.join(getDataDir(), 'orchestrator-archives');
const inFlight = new Map<string, Promise<AutoCompactResult>>();
type PersistedThread = { tabId: string; messages: MobileTranscriptEntry[] };
export const ORCHESTRATOR_COMPACTION_PROVENANCE = {
  backend: 'codex',
  model: MODEL_IDS.codexCliDefault,
  reasoningEffort: 'medium',
} as const;
export interface AutoCompactResult {
  applied: boolean;
  transcript: MobileTranscriptEntry[];
  resumePrelude: string | null;
  tokensAfter: number;
  compactedBy: typeof ORCHESTRATOR_COMPACTION_PROVENANCE | null;
  archiveRef: string | null;
}
const notApplied = (transcript: MobileTranscriptEntry[], tokensAfter = 0): AutoCompactResult => ({
  applied: false,
  transcript,
  resumePrelude: null,
  tokensAfter,
  compactedBy: null,
  archiveRef: null,
});
const fmtStamp = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const approxTokens = (value: string) => Math.max(0, Math.ceil(value.length / 4));
function coerceEntry(value: unknown): MobileTranscriptEntry | null {
  const record = value as Record<string, unknown> | null;
  const role = record?.role;
  return record && typeof record.id === 'string' && (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool')
    ? {
      ...(record as unknown as MobileTranscriptEntry),
      pinned: record.pinned === true,
      role,
      text: typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : '',
    }
    : null;
}
async function readThread(repoPath: string, threadId: string): Promise<PersistedThread | null> {
  if (!threadId.startsWith('thoughts-')) return null;
  const filePath = getCanonicalChatHistoryPath(threadId);
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if ((payload.repoPath as string | undefined)?.trim() !== repoPath) return null;
    const messages = Array.isArray(payload.messages) ? payload.messages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[] : [];
    return messages.length === 0 ? null : {
      tabId: threadId,
      messages,
    };
  } catch {
    return null;
  }
}
function buildExcerpt(messages: MobileTranscriptEntry[], maxChars: number) {
  const chunks = messages.map((entry, index) => {
    const role = entry.type === 'compaction' ? 'COMPACTION' : entry.role.toUpperCase();
    const text = compactionEntryText(entry, clipCompactionText) || '[no text]';
    return [`Turn ${index + 1} · ${role}${entry.timestampLabel ? ` · ${entry.timestampLabel}` : ''}`, text].join('\n');
  });
  // Over budget, the oldest turns go first: the newest carry the live state. An
  // earlier compaction summary stays, since it already condenses everything before it.
  const isSummary = (index: number) => messages[index]!.type === 'compaction';
  let size = chunks.reduce((sum, chunk, index) => (isSummary(index) ? sum + chunk.length : sum), 0);
  let start = chunks.length;
  for (; start > 0; start -= 1) {
    if (isSummary(start - 1)) continue;
    if (size + chunks[start - 1]!.length > maxChars) break;
    size += chunks[start - 1]!.length;
  }
  return chunks.filter((_, index) => index >= start || isSummary(index)).join('\n\n');
}
const toStoredMessage = (entry: MobileTranscriptEntry) => ({ ...entry, content: entry.text });

/** Model context is a projection; compaction never truncates the visible record. */
function contextTranscript(messages: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const summary = messages.findLast(entry => entry.compaction?.source === 'summary');
  const throughId = summary?.compaction?.compactedThroughId;
  const boundary = throughId ? messages.findIndex(entry => entry.id === throughId) : -1;
  // Legacy summaries already replaced their prefix. Preserve that input shape
  // until a new summary records an explicit identity boundary.
  if (!summary || boundary < 0) return messages;
  return [summary, ...messages.filter((entry, index) => entry.type !== 'compaction'
    && (entry.pinned === true || index > boundary))];
}

function splitCompactionWindow(transcript: MobileTranscriptEntry[], compactedCount: number) {
  const compactedWindow = transcript.slice(0, compactedCount);
  const compactedTurns = compactedWindow.filter((entry) => entry.pinned !== true);
  const pinnedTurns = compactedWindow.filter((entry) => entry.pinned === true);
  const liveTurns = transcript.slice(compactedCount);
  return {
    compactedTurns,
    pinnedTurns,
    liveTurns,
    retainedTurns: [...pinnedTurns, ...liveTurns],
  };
}
/**
 * Summarize a thread segment via Codex GPT-5.5 (medium reasoning effort).
 * Replaces the previous `claude --print haiku` spawn — same role (cheap fast
 * summarization), but Codex is free for ChatGPT Plus / Codex sub users and
 * doesn't bill against the Anthropic Agent SDK pool (#1046, epic #1044).
 *
 * Compaction is summarization, not orchestrator-class reasoning, so we use
 * `model_reasoning_effort=medium` — xhigh wastes wall time here. Passes
 * `--skip-git-repo-check` so codex doesn't refuse on untrusted repos (the
 * summary doesn't need git context at all).
 */
type CodexSummaryResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
};

async function summarizeWithCodex(repoPath: string, prompt: string): Promise<CodexSummaryResult> {
  const { resolveCli } = await import('@/lib/runtimes/shared/cli-resolver');
  const codexBin = (await resolveCli({
    runtimeId: 'codex',
    binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN',
  })).path;

  // The prompt is a conversation transcript — free text. On Windows the spawn
  // has to go through cmd.exe (codex is `codex.cmd`), and cmd expands `%VAR%`
  // inside quoted arguments, so a transcript on argv is both corruptible and an
  // injection surface. Send it on stdin there instead — the same way the Brain's
  // codex adapter has always fed `codex exec`. POSIX keeps argv unchanged.
  const promptOnStdin = process.platform === 'win32';
  return await new Promise<CodexSummaryResult>((resolve, reject) => {
    const launch = cliInvocation(codexBin, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      `model=${MODEL_IDS.codexCliDefault}`,
      '-c',
      'model_reasoning_effort=medium',
      '-C',
      repoPath,
      ...(promptOnStdin ? [] : [prompt]),
    ]);
    const child = spawn(
      launch.command,
      launch.args,
      {
        windowsHide: true,
        cwd: repoPath,
        stdio: [promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: childEnvironment({ runtimeId: 'codex', env: { FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' } }),
      },
    );
    if (promptOnStdin) {
      child.stdin?.write(prompt, 'utf-8');
      child.stdin?.end();
    }
    let buffer = '';
    let stderr = '';
    let result = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    // stdio[1]/stdio[2] are always 'pipe' above; only stdin varies by platform,
    // which is enough to cost the tuple its literal type.
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // codex-cli 0.130.0 emits the final reply as item.completed with
          // item.type='agent_message' and the body on item.text. Older builds
          // use event_msg/agent_message — both accepted, same way codex-
          // orchestrator-session.ts handles them.
          const item = parsed.item as Record<string, unknown> | undefined;
          if (parsed.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
            result = item.text;
          } else if (parsed.type === 'turn.completed') {
            const usage = parsed.usage as Record<string, unknown> | undefined;
            if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
            if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
          } else if (parsed.type === 'event_msg') {
            const payload = parsed.payload as Record<string, unknown> | undefined;
            if (payload?.type === 'agent_message' && typeof payload.message === 'string') {
              result = payload.message;
            }
          }
        } catch {
          // ignore partial lines / non-JSON banner output
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      const text = result.trim();
      if (code === 0 && text) resolve({
        text,
        inputTokens: inputTokens ?? approxTokens(prompt),
        outputTokens: outputTokens ?? approxTokens(text),
        estimated: inputTokens === null || outputTokens === null,
      });
      else reject(new Error(stderr.trim() || `Codex compaction failed (${code ?? 'unknown'})`));
    });
  });
}

function recordCompactionUsage(
  repoPath: string,
  threadId: string | null,
  result: CodexSummaryResult,
  compactedAt: Date,
): void {
  try {
    logUsage({
      userId: null,
      model: ORCHESTRATOR_COMPACTION_PROVENANCE.model,
      provider: 'openai',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: 0,
      sessionKey: `compaction:${threadId ?? 'orchestrator'}:${compactedAt.getTime()}`,
      repoPath,
      agentName: 'orchestrator-compaction',
      requestType: 'completion',
      role: 'compaction',
      metadata: {
        estimated: result.estimated,
        source: result.estimated ? 'chars_per_four' : 'codex_turn_completed',
      },
    });
  } catch (error) {
    console.warn('[auto-compact] usage ledger write failed:', error);
  }
}
// ── digest() — Fable Slice 5 (2026-07-02) ────────────────────────────────────

export interface DigestResult {
  digest: string;
  approxInputTokens: number;
  approxDigestTokens: number;
  truncatedInput: boolean;
}

/** Argv-safety cap — the prompt rides as a single codex argv element. */
const DIGEST_INPUT_CHAR_CAP = 180_000;

/**
 * Pre-digest arbitrary bulk (logs, test output, a diff, docs, a transcript)
 * into the smallest faithful summary a decision-maker can act on — the
 * metered-orchestrator window's inbound-bulk lever (lever 4). Runs on the same
 * Codex-medium engine as compaction, at $0 marginal (fixed sub).
 *
 * Adversarial digestion (Q synthesis #3): every call spawns a FRESH read-only
 * codex exec — the digest never comes from the proposing worker's session, so
 * no summarizer grades its own work.
 */
export async function digest(text: string, repoPath: string): Promise<DigestResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('digest: text is required');
  const truncatedInput = trimmed.length > DIGEST_INPUT_CHAR_CAP;
  const capped = truncatedInput
    ? `${trimmed.slice(0, DIGEST_INPUT_CHAR_CAP)}\n[... input truncated at ${DIGEST_INPUT_CHAR_CAP} chars ...]`
    : trimmed;
  const summaryResult = await summarizeWithCodex(repoPath, [
    'Digest the following material into the smallest faithful summary a decision-maker can act on. Use exactly these sections with terse bullets:',
    'What this is',
    'Key facts / findings',
    'Errors or failures (keep load-bearing lines verbatim)',
    'Decisions needed',
    'Use file paths, symbols, and numbers verbatim. If a section is empty, write "- None." Do not editorialize or add recommendations beyond the material.',
    '',
    capped,
  ].join('\n'));
  const summary = summaryResult.text;
  return {
    digest: summary,
    approxInputTokens: approxTokens(capped),
    approxDigestTokens: approxTokens(summary),
    truncatedInput,
  };
}

export async function autoCompactOrchestratorThread(input: {
  repoPath: string;
  threadId: string;
  /** Parent-session context tokens only. Child usage belongs to cost receipts. */
  runningTotal?: number;
  contextSource?: string;
  keepTailCount?: number;
  trigger?: 'auto' | 'manual' | 'handoff';
  /** Explicit handoffs must compact truthfully even when background compaction is disabled. */
  force?: boolean;
}): Promise<AutoCompactResult> {
  const repoPath = input.repoPath.trim();
  const threadId = input.threadId.trim();
  if (!repoPath || !threadId.startsWith('thoughts-')) return notApplied([]);

  // Gate background LLM work on the in-app orchestrator toggle (#1046, epic
  // #1044). Toggle ON means user has at least one sub (Codex) and wants the
  // background performance features. Toggle OFF means we silently skip
  // compaction — the thread keeps growing but no LLM calls happen.
  const { resolveInAppOrchestratorEnabledSync } = await import('@/lib/operator/defaults');
  if (!input.force && !resolveInAppOrchestratorEnabledSync()) {
    return notApplied([]);
  }
  const inFlightKey = `${repoPath}\0${threadId}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;
  const job = (async () => {
    const thread = await readThread(repoPath, threadId);
    if (!thread) return notApplied([]);
    const transcript = contextTranscript(thread.messages);
    if (transcript.length < 2) return notApplied(transcript);
    const keepTailCount = typeof input.keepTailCount === 'number' && Number.isFinite(input.keepTailCount)
      ? Math.max(1, Math.floor(input.keepTailCount))
      : null;
    if (keepTailCount !== null && transcript.length <= keepTailCount + 1) {
      return notApplied(transcript);
    }
    let compactedCount = keepTailCount !== null
      ? Math.max(1, transcript.length - keepTailCount)
      : Math.max(1, Math.floor(transcript.length * 0.6));
    // A message count is not a turn boundary. Include the answer and tool
    // results belonging to the last selected user message in the summary.
    while (compactedCount < transcript.length && transcript[compactedCount]!.role !== 'user') {
      compactedCount += 1;
    }
    const { compactedTurns } = splitCompactionWindow(transcript, compactedCount);
    if (compactedTurns.length === 0) {
      return notApplied(transcript);
    }
    return withLiveCompaction({ repoPath, threadId }, async () => {
      // Record-only judgment scores (#2465), asked beside the summarizer; nothing reads them.
      const scorerJob = scoreCompactionSegment(compactedTurns);
      const summaryResult = await summarizeWithCodex(repoPath, ['Summarize this orchestrator thread segment using exactly these sections and terse bullets:', 'Decisions made', 'Files touched', 'Open questions', 'Current mission state', 'Use file paths verbatim. If a section is empty, write "- None."', '', buildExcerpt(compactedTurns, 90_000)].join('\n'));
      const compactedAt = new Date();
      const compactedStamp = fmtStamp(compactedAt);
      const summary = summaryResult.text;
      recordCompactionUsage(repoPath, thread.tabId, summaryResult, compactedAt);
      const displaySummary = `<compacted_context turns="${compactedTurns.length}" at="${compactedStamp}">\n${summary}\n</compacted_context>`;
      const compactionEntry: MobileTranscriptEntry = {
        id: `orch-compaction-${compactedAt.getTime()}`,
        role: 'system',
        text: 'Context compaction event',
        type: 'compaction',
        timestamp: compactedAt.getTime(),
        timestampLabel: compactedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        compaction: {
          timestamp: compactedAt.getTime(),
          tokensBefore: typeof input.runningTotal === 'number' ? input.runningTotal : undefined,
          contextSource: input.contextSource,
          tokensAfter: undefined,
          trigger: input.trigger === 'handoff' ? 'manual' : input.trigger ?? 'auto',
          source: 'summary',
          compactedThroughId: transcript[compactedCount - 1]!.id,
          summary: displaySummary,
          compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
        },
      };
      const scorer = await scorerJob;
      if (scorer) compactionEntry.compaction!.scorer = scorer;
      await mkdir(ARCHIVE_DIR, { recursive: true });
      const archiveRef = `${thread.tabId}-${compactionEntry.id}.json`;
      compactionEntry.compaction!.archiveRef = archiveRef;
      await writeFile(path.join(ARCHIVE_DIR, archiveRef), JSON.stringify({
        repoPath,
        tabId: thread.tabId,
        archivedAt: compactedAt.toISOString(),
        compactedCount: compactedTurns.length,
        turns: compactedTurns.map(toStoredMessage),
        summary,
        compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
        ...(scorer ? { scorer } : {}),
      }));
      return withCanonicalChatHistoryLock(thread.tabId, () => {
        // Re-read inside the same per-thread lock as every other writer. A
        // summary may take seconds; its starting snapshot cannot replace live
        // output, metadata changes, or a deleted/reassigned conversation.
        const current = readPersistedLlmChat(thread.tabId)?.history;
        if (!current || current.repoPath?.trim() !== repoPath) {
          throw new Error('Conversation changed while compaction was running.');
        }
        const latest = current.messages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[];
        const summarized = new Map(compactedTurns.map(entry => [entry.id, JSON.stringify(entry)]));
        const latestById = new Map(latest.map(entry => [entry.id, JSON.stringify(entry)]));
        if (compactedTurns.some(entry => latestById.get(entry.id) !== summarized.get(entry.id))) {
          throw new Error('Summarized messages changed while compaction was running.');
        }
        const retainedTurns = contextTranscript(latest).filter(entry => !summarized.has(entry.id));
        const nextTranscript = [compactionEntry, ...retainedTurns];
        const resumePrelude = [`Compaction summary (${compactedStamp})`, summary, '', 'Most recent uncompressed turns:', buildExcerpt(retainedTurns, 80_000) || '- None.', '', 'Continue from that context. The operator message follows below.'].join('\n');
        const tokensAfter = approxTokens(resumePrelude);
        compactionEntry.compaction!.tokensAfter = tokensAfter;
        persistCanonicalChatHistoryRecordUnlocked(thread.tabId, {
          ...current,
          messages: [...current.messages, toStoredMessage(compactionEntry)],
          savedAt: compactedAt.toISOString(),
        }, compactedAt.toISOString());
        return {
          applied: true,
          transcript: nextTranscript,
          resumePrelude,
          tokensAfter,
          compactedBy: ORCHESTRATOR_COMPACTION_PROVENANCE,
          archiveRef,
        };
      });
    });
  })().finally(() => {
    inFlight.delete(inFlightKey);
  });
  inFlight.set(inFlightKey, job);
  return job;
}
