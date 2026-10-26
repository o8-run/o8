/**
 * Persisted terminal tab state — survives app restarts.
 * Stored per workspace tile under ~/.o8/terminal-states/<scope>.json
 */

import { fetchOnce } from '@/lib/panel/fetch-cache';
import { isTerminalChatConnectivityPrompt } from '@/lib/orchestrator/connectivity-check';
import type { TerminalExitState } from '@/lib/terminal/exit-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestrationMode, OrchestratorRuntime, WorkspaceOrchestrationPacketBadge } from '@/lib/orchestrator/types';
import {
  isOwnedOrchestratorSessionKey,
  isOrchestratorRuntime,
  runtimeFromOwnedSessionKey,
} from '@/lib/orchestrator/runtime-capabilities';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';

export interface PersistedChatCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  sourceMessageId?: string;
  messages: MobileTranscriptEntry[];
}

export interface PersistedTab {
  id: string;
  label: string;
  kind?: 'terminal' | 'chat' | 'llm-chat' | 'chatgpt-plan' | 'canvas' | 'orchestrator' | 'fleet-canvas'; // defaults to 'terminal' for backward compat
  cliAgent: string; // 'shell' | 'claude' | 'codex' | etc
  repoName?: string;
  repoPath?: string;
  tmuxSession?: string; // last known tmux session name (may still be alive)
  terminalExit?: TerminalExitState;
  readOnly?: boolean; // live run view: never send input to an attached PTY
  remoteMachine?: { id: string; label: string; sessionId: string };
  chatRuntime?: OrchestratorRuntime; // for kind='chat' (CLI Session)
  chatSessionKey?: string; // for kind='chat' (CLI Session)
  /** Stable lane identity behind a dispatched chat tab (#1553) — survives the
   *  per-attempt sessionKey churn so relaunches retarget instead of minting. */
  laneId?: string | null;
  claudeSessionId?: string; // persisted Claude Code session_id for --resume
  chatModel?: string;
  chatContinueLatest?: boolean;
  chatCheckpoints?: PersistedChatCheckpoint[];
  /**
   * Sticky composer mode for orchestrator-kind tabs (#F4 in the 2026-05-23
   * dogfood findings). Pre-fix this was missing from persistence; the restore
   * heuristic in `terminal-restore.ts` then defaulted to `kind: 'llm-chat'`,
   * which silently forced the tab into Chat mode even though the saved
   * transcript was clearly an orchestrator turn. Persist + rehydrate so the
   * orchestrator vs chat decision survives reload.
   */
  mode?: OrchestrationMode;
  /** When `mode === 'single'`, which runtime this tab dispatches to. */
  singleRuntime?: OrchestratorRuntime;
  /** Chat-mode model selection (o8 free-tier OpenRouter pool vs BYOK). */
  chatModelId?: ChatModelId;
  /** Per-tab pinned OpenRouter model slug overriding the chain. */
  chatOpenrouterModel?: string;
  /**
   * The chat-history thread id (`thoughts-…`) an orchestrator tab is showing.
   * Persisted so reload reopens the exact conversation per-tab instead of
   * collapsing every orchestrator tab onto the global last-active thread.
   */
  orchestratorThreadId?: string;
  /** An explicitly started unsent orchestrator tab must stay fresh after reload. */
  freshSpawn?: boolean;
  /** Transient host for externally-dispatched worker transcripts. */
  outsideWorkerHost?: boolean;
  linkedIssue?: {
    repo: string;
    number: number;
    title: string;
    body?: string | null;
    url?: string;
  };
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
  canvasTab?: {
    id: string;
    kind: string;
    label: string;
    resourceId: string;
    meta?: Record<string, string>;
  };
}

export interface PersistedTabState {
  version: 1;
  activeTabId: string;
  tabs: PersistedTab[];
  savedAt: string; // ISO timestamp
}

export type PersistedRuntimeSessionKey =
  | `cloud:${string}`
  | `codex:${string}`
  | `codex-owned:${string}`
  | `codex-discovered:${string}`
  | `codex-live:${string}`
  | `claude-code:${string}`
  | `gemini-owned:${string}`
  | `opencode-owned:${string}`
  | `openhands-owned:${string}`
  | `goose-owned:${string}`
  | `qwen-owned:${string}`
  | `kimi-owned:${string}`
  | `aider-owned:${string}`
  | `3code-owned:${string}`
  | `cursor-owned:${string}`
  | `grok-owned:${string}`
  | `prime-agent-owned:${string}`
  | `pi-owned:${string}`;

const API_PATH = '/api/panel/terminal-state';

export function persistedTabStateSavedAt(state: unknown): number {
  const savedAt = (state as Partial<PersistedTabState> | null)?.savedAt;
  const timestamp = typeof savedAt === 'string' ? Date.parse(savedAt) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Hard cap on persisted tabs per scope. Dogfood-week users accumulate dozens of
 * stale chat tabs (the user hit 84 in `repo-1j19dlc.json`); fresh installs are
 * fine. The cap is enforced both on save (preventatively) and on load
 * (defensively, for files already on disk).
 */
export const MAX_PERSISTED_TABS = 50;

/**
 * Issue #717 — canonical "is this a valid persisted tab?" filter. Applied at
 * EVERY layer (server GET, server POST, client load, client save, in-memory
 * mutations, hydration migration) so a zombie can never sneak in from any
 * direction. Currently the only zombie shape we know about:
 *
 *   `id.startsWith('orchestrator-')` AND `kind !== 'orchestrator'`
 *
 * These come from older builds (pre-#714) that mutated an orchestrator tab's
 * `kind` away from 'orchestrator' while leaving the orchestrator-prefixed ID
 * on disk. The migration effect in the controller injects a fresh pinned
 * Orchestrator on every mount, so the persisted stub becomes a duplicate the
 * user sees as "two Orchestrator tabs."
 *
 * Zombie shape 2 (#1293): best-of-N comparison CANDIDATE chat tabs. Candidates
 * (`fanOutComparisonPackets`) carry a `-cmp-<n>` suffix on their packetId +
 * branchTarget and are driven by the compare matrix + lane lifecycle — they are
 * NEVER meant to persist as standalone restored tabs. A failed/aborted best-of-N
 * left a dozen of them on disk that reopened as phantom "Agent working" tabs on
 * every reboot (the `-cmp-` zombies). `stripOrchestratorZombies` only matched
 * shape 1, so these survived. Strip any tab whose orchestrationPacket is a
 * `-cmp-<n>` candidate.
 *
 * Extend this function — not bespoke filters elsewhere — when new zombie
 * shapes are discovered. That's the whole point of having one source of truth.
 */
const COMPARISON_CANDIDATE_RE = /-cmp-\d+/;

export function stripPersistedTabs<T extends {
  id?: string;
  kind?: string;
  label?: string;
  orchestrationPacket?: { packetId?: string; branchTarget?: string | null } | null;
}>(tabs: T[]): T[] {
  return tabs.filter((tab) => {
    if (!tab || typeof tab !== 'object') return false;
    const id = typeof tab.id === 'string' ? tab.id : '';
    const kind = typeof tab.kind === 'string' ? tab.kind : '';
    // Shape 1: orchestrator-prefixed id with a non-orchestrator kind.
    if (kind !== 'orchestrator' && id.startsWith('orchestrator-')) return false;
    // Shape 2 (#1293): best-of-N comparison candidate chat tabs.
    const pkt = tab.orchestrationPacket;
    // Shape 3: the legacy connectivity probe was saved as a conversation tab.
    if (!pkt && ['orchestrator', 'llm-chat', 'chat'].includes(kind)
      && isTerminalChatConnectivityPrompt(tab.label)) return false;
    if (pkt && (COMPARISON_CANDIDATE_RE.test(pkt.packetId ?? '') || COMPARISON_CANDIDATE_RE.test(pkt.branchTarget ?? ''))) {
      return false;
    }
    return true;
  });
}

/**
 * Apply `stripPersistedTabs` to a `PersistedTabState`-shaped payload. Drops
 * zombie tabs and re-points `activeTabId` if the previously-active tab was
 * one of the zombies. Returns the same reference when the input is already
 * clean, so callers can cheaply skip redundant work.
 */
export function sanitizePersistedTabState(state: PersistedTabState): PersistedTabState {
  if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) return state;
  const sanitized = stripPersistedTabs(state.tabs);
  if (sanitized.length === state.tabs.length) return state;
  const activeStillPresent = sanitized.some((tab) => tab.id === state.activeTabId);
  return {
    ...state,
    tabs: sanitized,
    activeTabId: activeStillPresent ? state.activeTabId : (sanitized[0]?.id ?? ''),
  };
}

/** Tabs that should never be dropped, even when over the cap. */
function isPinnedKind(kind: PersistedTab['kind']): boolean {
  // Only orchestrator tabs are universally pinned. llm-chat tabs USED to be
  // pinned here, but that turned historical chats into permanent zombie
  // tabs that auto-restored on cold launch next to every fresh "+ New
  // session" the operator created. llm-chats are now subject to the
  // is-dead test below — alive chats (with checkpoints or an orchestration
  // packet) still survive, dead historicals go to the chat-history sidebar
  // where they actually belong.
  return kind === 'orchestrator';
}

/**
 * A tab is "clearly dead" if it carries no signal of live work. Conservative —
 * we'd rather keep something stale than drop an in-flight mission. Returns
 * `true` only for the obvious zombies.
 */
function isClearlyDeadTab(tab: PersistedTab): boolean {
  const kind = tab.kind ?? 'terminal';

  // chat (CLI Session): dead when no runtime session AND no saved checkpoints
  // AND no live orchestration packet attached. Packets indicate a dispatched
  // mission — that's live work even if the runtime session has rolled over.
  if (kind === 'chat') {
    const hasSessionKey = Boolean(tab.chatSessionKey?.trim() || tab.claudeSessionId?.trim());
    const hasCheckpoints = Boolean(tab.chatCheckpoints?.length);
    const hasPacket = Boolean(tab.orchestrationPacket);
    return !hasSessionKey && !hasCheckpoints && !hasPacket;
  }

  // llm-chat (casual o8 Chat): dead when there's no live work signal. The
  // chat-history sidebar still shows the saved thread; the tab itself
  // doesn't need to auto-open on next launch. The active tab is preserved
  // separately (phase 1 of pruneTabs); this rule only applies to background
  // tabs the operator left behind.
  if (kind === 'llm-chat') {
    const hasCheckpoints = Boolean(tab.chatCheckpoints?.length);
    const hasPacket = Boolean(tab.orchestrationPacket);
    return !hasCheckpoints && !hasPacket;
  }

  // terminal: drop pure dead leaves — no tmux session AND no repo binding.
  // Terminal tabs with a tmuxSession but no recent activity are kept because
  // we can't easily check tmux liveness from this layer (it's a client-side
  // helper); the restore path already handles that with `checkAliveSessions`.
  if (kind === 'terminal') {
    const hasTmuxSession = Boolean(tab.tmuxSession?.trim());
    const hasRepoPath = Boolean(tab.repoPath?.trim());
    const hasRemoteMachine = Boolean(tab.remoteMachine?.id && tab.remoteMachine.sessionId);
    return !hasTmuxSession && !hasRepoPath && !hasRemoteMachine;
  }

  return false;
}

/**
 * Trim a persisted tab list down to a sane size. Always preserves the active
 * tab + Orchestrator + Assistant pins; drops obvious zombies first; falls back
 * to age-based trimming (array order = recency proxy) if still over cap.
 */
export function pruneTabs(
  tabs: PersistedTab[],
  activeTabId: string,
): { tabs: PersistedTab[]; dropped: number } {
  const original = tabs.length;
  if (original === 0) return { tabs, dropped: 0 };

  // Phase 1: drop clearly-dead tabs that aren't pinned + aren't the active tab.
  const survivors = tabs.filter((tab) => {
    if (tab.id === activeTabId) return true;
    if (isPinnedKind(tab.kind)) return true;
    return !isClearlyDeadTab(tab);
  });

  // Phase 2: if still over cap, trim oldest non-pinned tabs. The persisted
  // file has no per-tab timestamps, so we treat array order as a recency
  // proxy — newer tabs are appended later by the controller. Walk from the
  // FRONT of the array (oldest), dropping non-pinned, non-active tabs until
  // length <= MAX_PERSISTED_TABS.
  let pruned = survivors;
  if (pruned.length > MAX_PERSISTED_TABS) {
    const overflow = pruned.length - MAX_PERSISTED_TABS;
    const toDropIds = new Set<string>();
    for (let i = 0; i < pruned.length && toDropIds.size < overflow; i += 1) {
      const candidate = pruned[i];
      if (!candidate) continue;
      if (candidate.id === activeTabId) continue;
      if (isPinnedKind(candidate.kind)) continue;
      toDropIds.add(candidate.id);
    }
    if (toDropIds.size > 0) {
      pruned = pruned.filter((tab) => !toDropIds.has(tab.id));
    }
  }

  return { tabs: pruned, dropped: original - pruned.length };
}

function hashScopeKey(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export function buildRepoStateScope(repoPath: string) {
  return `repo-${hashScopeKey(repoPath)}`;
}

export function formatPersistedRuntimeSessionKey(
  runtime?: PersistedTab['chatRuntime'],
  sessionKey?: string | null,
): PersistedRuntimeSessionKey | null {
  const trimmed = sessionKey?.trim();
  if (!trimmed || !runtime) return null;
  if (trimmed.startsWith('cloud:')) return trimmed as PersistedRuntimeSessionKey;
  if (runtime === 'cloud') return `cloud:${trimmed}`;
  if (isOwnedOrchestratorSessionKey(trimmed)) return trimmed as PersistedRuntimeSessionKey;
  if (runtime === 'codex' && (
    trimmed.startsWith('codex:')
    || trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
  )) {
    return trimmed as PersistedRuntimeSessionKey;
  }
  if (runtime === 'codex' || runtime === 'claude-code') {
    return trimmed.startsWith(`${runtime}:`)
      ? trimmed as PersistedRuntimeSessionKey
      : `${runtime}:${trimmed}`;
  }
  return isOrchestratorRuntime(runtime)
    ? `${runtime}-owned:${trimmed}` as PersistedRuntimeSessionKey
    : null;
}

export function stripPersistedRuntimeSessionKey(
  runtime?: PersistedTab['chatRuntime'],
  sessionKey?: string | null,
) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) return undefined;
  if (!runtime) return trimmed;
  if (trimmed.startsWith('cloud:')) return trimmed;
  if (isOwnedOrchestratorSessionKey(trimmed)) return trimmed;
  if (runtime === 'codex' && (
    trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
  )) {
    return trimmed;
  }
  return trimmed.startsWith(`${runtime}:`) ? trimmed.slice(`${runtime}:`.length) : trimmed;
}

export async function loadLiveRuntimeSessionKeys(): Promise<Set<PersistedRuntimeSessionKey>> {
  try {
    const res = await fetchOnce('/api/runtime/inventory?fresh=1', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!res.ok) return new Set();
    const data = await res.json() as { agents?: Array<{ sessionKey?: string; runtime?: string }> };
    const keys = (data.agents ?? [])
      .map((agent) => agent.sessionKey?.trim())
      .filter((value): value is PersistedRuntimeSessionKey => {
        if (typeof value !== 'string' || !value) return false;
        return value.startsWith('codex:')
          || value.startsWith('codex-owned:')
          || value.startsWith('codex-discovered:')
          || value.startsWith('codex-live:')
          || value.startsWith('claude-code:')
          || runtimeFromOwnedSessionKey(value) !== null;
      });
    return new Set(keys);
  } catch {
    return new Set();
  }
}

function buildStatePath(scope: string, repoPath?: string | null) {
  const params = new URLSearchParams();
  params.set('scope', scope);
  if (repoPath) {
    params.set('repoPath', repoPath);
  }
  return `${API_PATH}?${params.toString()}`;
}

const LOCALSTORAGE_SCRUB_MARKER_KEY = 'o8:tab-state:localstorage-scrubbed';
const LOCALSTORAGE_SCRUB_VERSION = '4147-v2';

/**
 * Issue #717 — one-time, no-op-if-already-clean migration.
 *
 * Walk every localStorage key whose value looks like a serialized tab list
 * (object/array containing a `tabs` array of `{id, kind}`) and run
 * `stripPersistedTabs` on it. Writes back only when something actually
 * changed. The marker key gates re-runs so the scrub costs ~one storage
 * iteration per app launch, then becomes a single getItem on subsequent
 * mounts.
 *
 * No tab persistence currently lives in localStorage, but the user's audit of
 * #717 found pre-fix zombies in WebKit-cached state and asked for a defensive
 * scrub here so the repo never has to open a 9th ship cycle if a future
 * persist middleware lands on top of localStorage.
 */
export function scrubLocalStorageTabZombies(): void {
  if (typeof window === 'undefined') return;
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }
  try {
    if (storage.getItem(LOCALSTORAGE_SCRUB_MARKER_KEY) === LOCALSTORAGE_SCRUB_VERSION) return;
  } catch {
    return;
  }

  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) keys.push(key);
    }
  } catch {
    return;
  }

  for (const key of keys) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw || raw.length < 16) continue;
    if (!raw.includes('"tabs"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const cleaned = scrubTabZombiesInValue(parsed);
    if (cleaned.changed) {
      try {
        storage.setItem(key, JSON.stringify(cleaned.value));
      } catch {
        // localStorage may be full; ignore
      }
    }
  }

  try {
    storage.setItem(LOCALSTORAGE_SCRUB_MARKER_KEY, LOCALSTORAGE_SCRUB_VERSION);
  } catch {
    // Marker write failed — re-running on next mount is a no-op-if-already-clean,
    // so the worst case is we walk localStorage once more.
  }
}

interface ScrubResult {
  value: unknown;
  changed: boolean;
}

function scrubTabZombiesInValue(value: unknown): ScrubResult {
  if (!value || typeof value !== 'object') return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = scrubTabZombiesInValue(entry);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  const obj = value as Record<string, unknown>;
  const tabs = obj.tabs;
  let changed = false;
  let next: Record<string, unknown> | null = null;

  if (Array.isArray(tabs)) {
    const sanitized = stripPersistedTabs(tabs as Array<{ id?: string; kind?: string }>);
    if (sanitized.length !== tabs.length) {
      next = { ...obj, tabs: sanitized };
      const activeTabId = typeof obj.activeTabId === 'string' ? obj.activeTabId : '';
      if (activeTabId && !sanitized.some((tab) => (tab as { id?: string }).id === activeTabId)) {
        next.activeTabId = (sanitized[0] as { id?: string } | undefined)?.id ?? '';
      }
      changed = true;
    }
  }

  for (const [k, v] of Object.entries(next ?? obj)) {
    if (k === 'tabs') continue;
    const result = scrubTabZombiesInValue(v);
    if (result.changed) {
      next = { ...(next ?? obj), [k]: result.value };
      changed = true;
    }
  }

  return { value: changed ? next : value, changed };
}

/** Save tab state to server */
export async function saveTabState(state: PersistedTabState, scope = 'tile-root'): Promise<void> {
  try {
    // #717 — apply the canonical zombie filter on save too. The server already
    // strips, but doing it here keeps the round-trip stable: in-memory ->
    // serialized -> server matches what we'll see on next load. Cheap, idempotent.
    const sanitized = sanitizePersistedTabState(state);
    const beforeCount = sanitized.tabs.length;
    const { tabs: prunedTabs, dropped } = pruneTabs(sanitized.tabs, sanitized.activeTabId);
    if (dropped > 0) {
      console.log(`[tab-state] pruned ${dropped} tabs on save (was ${beforeCount}, now ${prunedTabs.length})`);
    }
    const persisted: PersistedTabState = dropped > 0
      ? { ...sanitized, tabs: prunedTabs }
      : sanitized;
    const res = await fetch(buildStatePath(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(persisted),
    });
    if (!res.ok) {
      console.warn(`[tab-state] save failed: HTTP ${res.status} (scope ${scope})`);
    }
  } catch (error) {
    // Non-critical for the UI, but never silent — a save that fails here is
    // invisible data loss on next relaunch (#1234).
    console.warn(`[tab-state] save failed (scope ${scope}):`, error);
  }
}

/** Load tab state from server */
export async function loadTabState(scope = 'tile-root', repoPath?: string | null): Promise<PersistedTabState | null> {
  try {
    // #717 — `cache: 'no-store'` so WebKit's HTTP response cache can never
    // serve a pre-#716 (un-sanitized) copy of this endpoint. Without this,
    // ~/Library/WebKit/<bundle>/WebsiteData/Default/ could keep returning the
    // zombie state for hours after the server-side strip shipped.
    const res = await fetch(buildStatePath(scope, repoPath), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (res.status === 204) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (data.version !== 1) return null;
    // #717 — apply the canonical zombie filter on load. Server already strips,
    // but a stale HTTP cache or an old build's response shape could still
    // contain zombies; this is the last-mile defense.
    const state = sanitizePersistedTabState(data as PersistedTabState);
    if (!Array.isArray(state.tabs) || state.tabs.length === 0) return state;
    const beforeCount = state.tabs.length;
    const { tabs: prunedTabs, dropped } = pruneTabs(state.tabs, state.activeTabId);
    if (dropped > 0) {
      console.log(`[tab-state] pruned ${dropped} tabs on load (was ${beforeCount}, now ${prunedTabs.length})`);
      return { ...state, tabs: prunedTabs };
    }
    return state;
  } catch {
    return null;
  }
}

/** Check which tmux sessions from the saved state are still alive */
export async function checkAliveSessions(sessionNames: string[]): Promise<Set<string>> {
  try {
    const res = await fetchOnce('/api/panel/terminal-sessions');
    if (!res.ok) return new Set(sessionNames);
    const data = await res.json();
    if (!Array.isArray(data.sessions) || data.sessions.some((session: unknown) => typeof session !== 'string')) return new Set(sessionNames);
    const alive = new Set<string>(data.sessions);
    return new Set(sessionNames.filter(s => alive.has(s)));
  } catch {
    // Unavailable evidence cannot prove a saved process has ended.
    return new Set(sessionNames);
  }
}
