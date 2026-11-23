import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CodexAppServerClient } from '@/lib/codex/app-server-client';
import { getDataDir } from '@/lib/data-dir-migration';
import { userCodexHome } from '@/lib/lane/codex-orchestrator-config';
import {
  appendMobileOrchestratorUserMessage,
  upsertMobileOrchestratorAssistantMessage,
} from '@/lib/mobile/orchestrator-thread-history';

/**
 * Turns the operator adds to an o8 chat from the Codex app (#3573 follow-up).
 * With "Show chats in the Codex app" on, an o8 chat runs in a Codex thread the
 * Codex app can continue, on desktop or phone. o8 records every Codex turn it
 * runs; any other completed turn in that thread came from the Codex app and is
 * copied into the o8 chat, so its transcript stays whole.
 */

export interface CodexAppSyncState {
  tabId: string;
  repoPath: string;
  threadId: string;
  rolloutPath: string | null;
  /** Codex turns already in the o8 chat: run by o8 or imported. */
  turnIds: string[];
  /** Imported turns that had no reply yet; a later reply replaces the placeholder. */
  placeholderTurnIds: string[];
}

export interface CodexAppTurn {
  id: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  userText: string;
  agentText: string;
}

export interface CodexAppThreadReader {
  rolloutPath(threadId: string): Promise<string | null>;
  /** Newest first, stopping once a turn in `known` is reached. */
  recentTurns(threadId: string, known: ReadonlySet<string>): Promise<CodexAppTurn[]>;
  close(): Promise<void>;
}

const MAX_TURN_IDS = 1_000;

function stateDir(): string {
  return join(getDataDir(), 'codex-app-sync');
}

function statePath(tabId: string): string {
  return join(stateDir(), `${tabId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readState(file: string): CodexAppSyncState | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CodexAppSyncState>;
    if (typeof parsed.tabId !== 'string' || typeof parsed.repoPath !== 'string' || typeof parsed.threadId !== 'string') return null;
    return {
      tabId: parsed.tabId,
      repoPath: parsed.repoPath,
      threadId: parsed.threadId,
      rolloutPath: typeof parsed.rolloutPath === 'string' ? parsed.rolloutPath : null,
      turnIds: Array.isArray(parsed.turnIds) ? parsed.turnIds.filter((id): id is string => typeof id === 'string') : [],
      placeholderTurnIds: Array.isArray(parsed.placeholderTurnIds)
        ? parsed.placeholderTurnIds.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writeState(state: CodexAppSyncState): void {
  mkdirSync(stateDir(), { recursive: true });
  const file = statePath(state.tabId);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...state, turnIds: state.turnIds.slice(-MAX_TURN_IDS) }), { mode: 0o600 });
  renameSync(temporary, file);
}

export function readCodexAppSyncState(tabId: string): CodexAppSyncState | null {
  return readState(statePath(tabId));
}

/** Record a Codex turn that o8 itself started, so the sync never imports it. */
export function noteCodexAppTurn(input: { tabId: string | null; repoPath: string; threadId: string; turnId: string }): void {
  if (!input.tabId?.startsWith('thoughts-')) return;
  const existing = readCodexAppSyncState(input.tabId);
  const sameThread = existing?.threadId === input.threadId;
  writeState({
    tabId: input.tabId,
    repoPath: input.repoPath,
    threadId: input.threadId,
    rolloutPath: sameThread ? existing.rolloutPath : null,
    turnIds: [...(existing?.turnIds ?? []).filter((id) => id !== input.turnId), input.turnId],
    placeholderTurnIds: sameThread ? existing.placeholderTurnIds : [],
  });
}

/** Read one bridge output line; record the turn when it is the bridge's `turn.started`. */
export function noteCodexAppTurnLine(line: string, input: { tabId: string | null; repoPath: string }): void {
  if (!line.includes('"turn.started"')) return;
  try {
    const parsed = JSON.parse(line) as { type?: unknown; turn_id?: unknown; thread_id?: unknown };
    if (parsed.type !== 'turn.started' || typeof parsed.turn_id !== 'string' || typeof parsed.thread_id !== 'string') return;
    noteCodexAppTurn({ ...input, threadId: parsed.thread_id, turnId: parsed.turn_id });
  } catch {
    // Not a bridge line.
  }
}

export interface CodexAppSyncDeps {
  /** True while o8 is running a turn for this chat; its turn is not imported. */
  isBusy(state: CodexAppSyncState): boolean;
  openReader(): Promise<CodexAppThreadReader>;
  onImported?(tabId: string, count: number): void;
}

const lastSeen = new Map<string, string>();
const recheckAt = new Map<string, number>();

/** The sync's own tick; the first retry after a failure waits this long. */
export const CODEX_APP_SYNC_RETRY_MS = 4_000;
export const CODEX_APP_SYNC_MAX_RETRY_MS = 10 * 60_000;
const OPEN_KEY = '\0open';

/**
 * Failures back off exponentially, capped, so a broken `codex app-server` (or a
 * thread it cannot read) is not restarted on every tick. The key is a chat, or
 * OPEN_KEY when the app-server itself would not start.
 */
const failures = new Map<string, { count: number; retryAt: number }>();

function backingOff(key: string, now = Date.now()): boolean {
  const failure = failures.get(key);
  return failure !== undefined && now < failure.retryAt;
}

function noteFailure(key: string, now = Date.now()): void {
  const count = (failures.get(key)?.count ?? 0) + 1;
  const delay = Math.min(CODEX_APP_SYNC_RETRY_MS * 2 ** (count - 1), CODEX_APP_SYNC_MAX_RETRY_MS);
  failures.set(key, { count, retryAt: now + delay });
}

class ReaderOpenError extends Error {}

/** Tests only. */
export function resetCodexAppSyncState(): void {
  stateCache = null;
  lastSeen.clear();
  recheckAt.clear();
  failures.clear();
}

/**
 * Read from a second app-server, a turn still running in the Codex app reports
 * `interrupted` with no reply until it ends (#3628). Such a turn is imported
 * only once its thread has been quiet this long.
 */
const UNSETTLED_TURN_QUIET_MS = 5 * 60_000;

/** One sync pass over every o8 chat linked to a Codex thread. Returns turns imported per chat. */
/**
 * The linked chats, read again only when the state folder changes. Every state
 * save writes a temporary file and renames it into the folder, so an unchanged
 * folder means unchanged states; each tick then only stats the Codex rollouts.
 */
let stateCache: { stamp: string; states: CodexAppSyncState[] } | null = null;

function linkedStates(): CodexAppSyncState[] | null {
  let stamp: string;
  try {
    const info = statSync(stateDir());
    stamp = `${info.ino}:${info.mtimeMs}`;
  } catch {
    stateCache = null;
    return null;
  }
  if (stateCache?.stamp === stamp) return stateCache.states;
  let files: string[];
  try {
    files = readdirSync(stateDir()).filter((file) => file.endsWith('.json'));
  } catch {
    stateCache = null;
    return null;
  }
  const states = files.map((file) => readState(join(stateDir(), file)))
    .filter((state): state is CodexAppSyncState => state !== null);
  stateCache = { stamp, states };
  return states;
}

export async function syncCodexAppThreads(deps: CodexAppSyncDeps): Promise<Map<string, number>> {
  const imported = new Map<string, number>();
  const states = linkedStates();
  if (!states) return imported;
  if (backingOff(OPEN_KEY)) return imported;
  let reader: CodexAppThreadReader | null = null;
  const open = async () => {
    if (reader) return reader;
    try {
      reader = await deps.openReader();
    } catch (error) {
      noteFailure(OPEN_KEY);
      throw new ReaderOpenError(error instanceof Error ? error.message : String(error));
    }
    failures.delete(OPEN_KEY);
    return reader;
  };
  try {
    for (const state of states) {
      if (deps.isBusy(state) || backingOff(state.tabId)) continue;
      try {
        const count = await syncThread(state, open, deps);
        failures.delete(state.tabId);
        if (count > 0) imported.set(state.tabId, count);
      } catch (error) {
        if (error instanceof ReaderOpenError) throw error;
        noteFailure(state.tabId);
      }
    }
  } finally {
    await (reader as CodexAppThreadReader | null)?.close();
  }
  return imported;
}

class ThreadUnreadableError extends Error {}

/** Sync one chat; returns turns imported. Throws when its Codex thread could not be read. */
async function syncThread(
  state: CodexAppSyncState,
  open: () => Promise<CodexAppThreadReader>,
  deps: CodexAppSyncDeps,
): Promise<number> {
  if (!state.rolloutPath) {
    state.rolloutPath = await (await open()).rolloutPath(state.threadId);
    if (!state.rolloutPath) throw new ThreadUnreadableError(state.threadId);
    writeState(state);
  }
  let marker: string;
  let quiet: boolean;
  try {
    const stat = statSync(state.rolloutPath);
    marker = `${state.threadId}:${stat.mtimeMs}:${stat.size}`;
    quiet = Date.now() - stat.mtimeMs >= UNSETTLED_TURN_QUIET_MS;
  } catch {
    return 0;
  }
  const due = recheckAt.get(state.tabId);
  if (lastSeen.get(state.tabId) === marker && (due === undefined || Date.now() < due)) return 0;
  const placeholders = new Set(state.placeholderTurnIds);
  const known = new Set(state.turnIds.filter((id) => !placeholders.has(id)));
  const turns = (await (await open()).recentTurns(state.threadId, known)).reverse();
  let changed = 0;
  let unsettled = false;
  for (const turn of turns) {
    const reply = turn.agentText.trim();
    if (placeholders.has(turn.id)) {
      if (!reply) continue;
      upsertMobileOrchestratorAssistantMessage({
        tabId: state.tabId,
        repoPath: state.repoPath,
        messageId: `codex-app-assistant-${turn.id}`,
        content: reply,
        backend: 'codex',
        sessionId: state.threadId,
        timestampMs: turn.completedAt ? turn.completedAt * 1_000 : undefined,
      });
      placeholders.delete(turn.id);
      changed += 1;
      continue;
    }
    if (known.has(turn.id) || !turn.userText.trim()) continue;
    const ended = turn.status === 'completed' || turn.status === 'failed';
    if (!reply && !ended && (turn.status === 'inProgress' || !quiet)) {
      unsettled = true;
      continue;
    }
    appendMobileOrchestratorUserMessage({
      tabId: state.tabId,
      repoPath: state.repoPath,
      message: turn.userText,
      messageId: `codex-app-user-${turn.id}`,
      backend: 'codex',
      timestampMs: turn.startedAt ? turn.startedAt * 1_000 : undefined,
    });
    upsertMobileOrchestratorAssistantMessage({
      tabId: state.tabId,
      repoPath: state.repoPath,
      messageId: `codex-app-assistant-${turn.id}`,
      content: reply || `(Codex turn ${turn.status} without a reply)`,
      backend: 'codex',
      sessionId: state.threadId,
      timestampMs: turn.completedAt ? turn.completedAt * 1_000 : undefined,
    });
    state.turnIds.push(turn.id);
    if (!reply && !ended) placeholders.add(turn.id);
    changed += 1;
  }
  if (changed > 0) {
    state.placeholderTurnIds = [...placeholders];
    writeState(state);
    deps.onImported?.(state.tabId, changed);
  }
  lastSeen.set(state.tabId, marker);
  // An unfinished turn may end without touching its rollout again; look
  // once more when the quiet window closes.
  if (unsettled) recheckAt.set(state.tabId, Date.now() + UNSETTLED_TURN_QUIET_MS);
  else recheckAt.delete(state.tabId);
  return changed;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toTurn(raw: unknown): CodexAppTurn | null {
  const turn = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!turn || typeof turn.id !== 'string') return null;
  const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : [];
  const user = items.find((item) => item?.type === 'userMessage');
  const userText = Array.isArray(user?.content)
    ? (user.content as Array<Record<string, unknown>>).map((part) => text(part?.text)).filter(Boolean).join('\n')
    : '';
  const agentText = [...items].reverse().find((item) => item?.type === 'agentMessage');
  return {
    id: turn.id,
    status: text(turn.status),
    startedAt: typeof turn.startedAt === 'number' ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === 'number' ? turn.completedAt : null,
    userText,
    agentText: text(agentText?.text),
  };
}

const TURN_PAGE = 20;
const MAX_TURN_PAGES = 5;

/** Read-only access to the operator's Codex threads through `codex app-server`. */
export async function openCodexAppThreadReader(): Promise<CodexAppThreadReader> {
  const { resolveCli } = await import('@/lib/runtimes/shared/cli-resolver');
  const cli = await resolveCli({
    runtimeId: 'codex',
    binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN',
    extraEnvOverrides: ['CODEX_HOME'],
  });
  const client = new CodexAppServerClient({ binaryPath: cli.path, codexHome: userCodexHome(), requestTimeoutMs: 15_000 });
  try {
    await client.initialize('o8');
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    async rolloutPath(threadId) {
      try {
        const result = await client.request('thread/read', { threadId }) as { thread?: { path?: unknown } };
        return typeof result.thread?.path === 'string' ? result.thread.path : null;
      } catch {
        return null;
      }
    },
    async recentTurns(threadId, known) {
      const turns: CodexAppTurn[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
        const result = await client.request('thread/turns/list', {
          threadId, limit: TURN_PAGE, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}),
        }) as { data?: unknown[]; nextCursor?: unknown };
        for (const raw of result.data ?? []) {
          const turn = toTurn(raw);
          if (!turn) continue;
          if (known.has(turn.id)) return turns;
          turns.push(turn);
        }
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
        if (!cursor) break;
      }
      return turns;
    },
    close: () => client.close(),
  };
}
