import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import { getDataDir } from '@/lib/data-dir-migration';
import type { PersistedLlmChatHistory } from '@/lib/llm/chat-history-store';

export type CrashSurvivableOrchestratorBackend = 'claude' | 'codex';

export type OrchestratorTurnOutcome = 'completed' | 'failed' | 'interrupted';

export interface OrchestratorTurnRecord {
  id: string;
  backend: CrashSurvivableOrchestratorBackend;
  sessionName: string;
  repoPath: string;
  threadId: string | null;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset?: number;
  startedAt: number;
  // Task #8 — turn ledger. A finished turn is MARKED settled (settledAt +
  // outcome), not deleted, so the ledger is the durable answer to "is a turn
  // in flight for this thread, and how did the last one end" — the server
  // truth that replaces the client's elapsed-silence heuristics. Settled
  // records prune after TURN_LEDGER_RETENTION_MS.
  settledAt?: number | null;
  outcome?: OrchestratorTurnOutcome | null;
  assistantMessageId?: string | null;
  assistantStartedAtMs?: number | null;
  model?: string | null;
}

export interface OrchestratorCrashSurvivalMeta {
  backend: CrashSurvivableOrchestratorBackend;
  threadId?: string | null;
  assistantMessageId?: string | null;
  assistantStartedAtMs?: number | null;
  model?: string | null;
}

function rootDir(): string {
  return join(
    getDataDir(),
    'orchestrator-turns',
  );
}

function disabledByEnv(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

export function crashSurvivableOrchestratorEnabled(): boolean {
  const raw = process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  if (raw === undefined || raw.trim() === '') return true;
  return !disabledByEnv(raw);
}

function ensureRoot(): void {
  mkdirSync(rootDir(), { recursive: true });
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 140);
}

function recordPath(id: string): string {
  return join(rootDir(), `${safeName(id)}.json`);
}

function repoHash(repoPath: string): string {
  return createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 8);
}

export function createOrchestratorTurnRecord(input: {
  backend: CrashSurvivableOrchestratorBackend;
  sessionName: string;
  repoPath: string;
  threadId?: string | null;
  pid: number;
  assistantMessageId?: string | null;
  assistantStartedAtMs?: number | null;
  model?: string | null;
}): OrchestratorTurnRecord {
  ensureRoot();
  const id = `${input.backend}-${repoHash(input.repoPath)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const stdoutPath = join(rootDir(), `${safeName(id)}.jsonl`);
  const stderrPath = join(rootDir(), `${safeName(id)}.stderr.log`);
  writeFileSync(stdoutPath, '', 'utf8');
  writeFileSync(stderrPath, '', 'utf8');
  const record: OrchestratorTurnRecord = {
    id,
    backend: input.backend,
    sessionName: input.sessionName,
    repoPath: resolve(input.repoPath),
    threadId: input.threadId ?? null,
    pid: input.pid,
    stdoutPath,
    stderrPath,
    startedAt: Date.now(),
    assistantMessageId: input.assistantMessageId ?? null,
    assistantStartedAtMs: input.assistantStartedAtMs ?? null,
    model: input.model ?? null,
  };
  writeFileSync(recordPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function createOrchestratorTurnRecordForFiles(input: {
  backend: CrashSurvivableOrchestratorBackend;
  sessionName: string;
  repoPath: string;
  threadId?: string | null;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset?: number;
  assistantMessageId?: string | null;
  assistantStartedAtMs?: number | null;
  model?: string | null;
}): OrchestratorTurnRecord {
  ensureRoot();
  const id = `${input.backend}-${repoHash(input.repoPath)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const record: OrchestratorTurnRecord = {
    id,
    backend: input.backend,
    sessionName: input.sessionName,
    repoPath: resolve(input.repoPath),
    threadId: input.threadId ?? null,
    pid: input.pid,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    stdoutOffset: input.stdoutOffset ?? 0,
    startedAt: Date.now(),
    assistantMessageId: input.assistantMessageId ?? null,
    assistantStartedAtMs: input.assistantStartedAtMs ?? null,
    model: input.model ?? null,
  };
  writeFileSync(recordPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function updateOrchestratorTurnPid(record: OrchestratorTurnRecord, pid: number): OrchestratorTurnRecord {
  const next = { ...record, pid };
  writeFileSync(recordPath(record.id), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Delete a record outright — for records that never represented a live turn
 * (e.g. the warm-spawn path allocates one just for its stream-file paths).
 * A settled-marker here would pollute the per-thread ledger with bogus
 * instantly-settled turns.
 */
export function discardOrchestratorTurnRecord(record?: OrchestratorTurnRecord | null): void {
  if (!record) return;
  rmSync(recordPath(record.id), { force: true });
}

// Settled turns are kept this long as the durable "how did the last turn end"
// answer, then pruned together with their stream files.
const TURN_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;

export function finishOrchestratorTurn(
  record?: OrchestratorTurnRecord | null,
  outcome: OrchestratorTurnOutcome = 'completed',
): void {
  if (!record) return;
  // Task #8 — mark settled instead of deleting. The record is the server's
  // durable turn truth: a client reconciling a phantom running timer or a
  // dropped transcript turn needs "this turn settled at T with outcome O",
  // which deletion destroyed.
  try {
    const settled: OrchestratorTurnRecord = { ...record, settledAt: Date.now(), outcome };
    writeFileSync(recordPath(record.id), `${JSON.stringify(settled, null, 2)}\n`, 'utf8');
  } catch {
    rmSync(recordPath(record.id), { force: true });
  }
}

function readAllTurnRecords(): OrchestratorTurnRecord[] {
  const dir = rootDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OrchestratorTurnRecord;
        return parsed?.id && parsed?.stdoutPath ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function liveSubagentIds(records: OrchestratorTurnRecord[]): Set<string> | null {
  const ids = new Set<string>();
  const threads = new Set<string>();
  for (const record of records) {
    if (record.settledAt) continue;
    // The stream covers children not yet checkpointed into chat history.
    try {
      for (const line of readFileSync(record.stdoutPath, 'utf8').split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (typeof event?.parent_tool_use_id === 'string') ids.add(event.parent_tool_use_id);
        const content = event?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') ids.add(block.id);
        }
      }
    } catch (error) {
      console.warn(`[orchestrator-retention] Failed to read live turn ${record.id}; keeping subagent transcripts`, error);
      return null;
    }
    if (record.threadId) threads.add(record.threadId);
  }
  // A live thread also owns children from its earlier, settled turns.
  for (const threadId of threads) {
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
      const history = JSON.parse(readFileSync(join(getDataDir(), 'chat-history', `${safe}.json`), 'utf8')) as PersistedLlmChatHistory;
      for (const message of history.messages) {
        for (const tool of message.toolCalls ?? []) {
          if (typeof tool.id === 'string') ids.add(tool.id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.warn(`[orchestrator-retention] Failed to read live thread ${threadId}; keeping subagent transcripts`, error);
      return null;
    }
  }
  return ids;
}

function pruneSubagentTranscripts(records: OrchestratorTurnRecord[], cutoff: number): void {
  const dir = join(getDataDir(), 'subagent-transcripts');
  let files;
  try {
    files = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[orchestrator-retention] Failed to list subagent transcripts', error);
    }
    return;
  }
  const live = liveSubagentIds(records);
  if (!live) return;
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl') || live.has(file.name.slice(0, -6))) continue;
    const filePath = join(dir, file.name);
    try {
      if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { force: true });
    } catch (error) {
      console.warn(`[orchestrator-retention] Failed to prune ${filePath}`, error);
    }
  }
}

function pruneSettledTurns(records: OrchestratorTurnRecord[]): void {
  const cutoff = Date.now() - TURN_LEDGER_RETENTION_MS;
  pruneSubagentTranscripts(records, cutoff);
  for (const record of records) {
    if (!record.settledAt || record.settledAt >= cutoff) continue;
    rmSync(recordPath(record.id), { force: true });
    // Stream files live in the ledger dir only for records the ledger created
    // (createOrchestratorTurnRecord); externally-owned paths are left alone.
    if (record.stdoutPath.startsWith(rootDir())) rmSync(record.stdoutPath, { force: true });
    if (record.stderrPath.startsWith(rootDir())) rmSync(record.stderrPath, { force: true });
  }
}

export function listActiveOrchestratorTurns(): OrchestratorTurnRecord[] {
  const records = readAllTurnRecords();
  pruneSettledTurns(records);
  return records.filter((record) => !record.settledAt);
}

/**
 * Task #8 — the per-thread turn ledger read. Returns this thread's turns,
 * newest first (active turn, if any, is first). Feeds the subscribe snapshot
 * so the client reconciles its running timer / transcript against server
 * truth instead of elapsed-silence heuristics.
 */
export function listOrchestratorTurnsForThread(threadId: string): OrchestratorTurnRecord[] {
  const normalized = threadId.trim();
  if (!normalized) return [];
  return readAllTurnRecords()
    .filter((record) => record.threadId === normalized)
    .sort((left, right) => right.startedAt - left.startedAt);
}

/** Includes settled records: abort acknowledgement does not prove process exit. */
export function listOrchestratorTurnsForSessions(sessionNames: readonly string[]): OrchestratorTurnRecord[] {
  const names = new Set(sessionNames);
  return readAllTurnRecords().filter((record) => names.has(record.sessionName));
}

export function isPidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS but cannot be signalled. Reading it as
    // dead here declares a live orchestrator REPL crashed and respawns a second
    // one on the same thread.
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Liveness for a REHYDRATED turn — `isPidAlive`, bounded by wall clock.
 *
 * After a restart the pid on a turn record is evidence, not proof: the OS may
 * have recycled it onto an unrelated process. `isPidAlive` deliberately treats
 * EPERM as alive (a process that exists but cannot be signalled is not dead),
 * which is right for the case it was written for and makes exactly this one
 * unfalsifiable — a recycled pid owned by another user answers "alive" forever,
 * and the session it gates stays `busy` for the life of the app with no turn
 * ever settling.
 *
 * The bound is the ceiling a LIVE turn already has (PROCESS_TIMEOUT_MS, enforced
 * by a watchdog timer that died with the process that owned it), measured from
 * when the turn started. So this is the existing policy surviving the restart,
 * not a new one: a turn that outlives the ceiling was going to be killed anyway.
 */
export function isRehydratedTurnAlive(
  record: Pick<OrchestratorTurnRecord, 'pid' | 'startedAt'>,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (nowMs - record.startedAt >= maxAgeMs) return false;
  return isPidAlive(record.pid);
}

export function readJsonlLines(filePath: string, fromOffset = 0): { lines: string[]; offset: number } {
  if (!existsSync(filePath)) return { lines: [], offset: fromOffset };
  const raw = readFileSync(filePath);
  const start = Math.min(Math.max(0, fromOffset), raw.byteLength);
  const tail = raw.subarray(start).toString('utf8');
  const lastNewline = tail.lastIndexOf('\n');
  if (lastNewline < 0) return { lines: [], offset: start };
  const complete = tail.slice(0, lastNewline);
  const lines = complete.split('\n').filter((line) => line.trim());
  const consumedBytes = Buffer.byteLength(tail.slice(0, lastNewline + 1), 'utf8');
  return { lines, offset: start + consumedBytes };
}

export function openAppendFile(filePath: string): number {
  ensureRoot();
  return openSync(filePath, 'a');
}

export function tailJsonlFile(options: {
  filePath: string;
  fromOffset?: number;
  alive: () => boolean;
  onLine: (line: string) => boolean | void;
  onOffset?: (offset: number) => void;
  onEnd: () => void;
  intervalMs?: number;
}): () => void {
  let offset = options.fromOffset ?? 0;
  let stopped = false;
  const intervalMs = options.intervalMs ?? 250;
  const tick = () => {
    if (stopped) return;
    const next = readJsonlLines(options.filePath, offset);
    offset = next.offset;
    options.onOffset?.(offset);
    for (const line of next.lines) {
      if (options.onLine(line) === false) {
        stopped = true;
        options.onEnd();
        return;
      }
    }
    if (!options.alive()) {
      stopped = true;
      options.onEnd();
      return;
    }
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 0);
  return () => { stopped = true; };
}

export function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function collectAssistantText(events: OrchestratorEvent[]): string {
  return events
    .filter((event): event is Extract<OrchestratorEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('');
}
