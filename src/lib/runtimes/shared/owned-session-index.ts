/**
 * Shared owned-session index (perf, 2026-07-03).
 *
 * Three timer sweepers — the silent-exit detector (twice per 30s tick) and the
 * lane zombie reaper (per 5-min tick) — each resolved a lane's owned session by
 * `readdir`+parsing EVERY `session.json` under the owned roots, per lane. That
 * is O(active-lanes × sessions) fs reads per tick with no sharing, and two
 * copies of the same `readOwnedActiveRun` loop. This module scans each root
 * ONCE and memoizes the result for a short TTL, so every per-lane lookup inside
 * a tick (and across sweepers within the window) shares one scan.
 *
 * TTL is deliberately tiny (2s): liveness does not change faster than a sweeper
 * tick, and every consumer's grace window (>= 45s) dwarfs 2s of staleness, so
 * the memo can never make a live session look dead or vice-versa within a
 * decision window. The lookup contract is:
 *   - lookup returns `null`  → surfaceId not present under its root
 *   - lookup returns `{}`    → present but `activeRun` cleared (definitively dead)
 *   - lookup returns `{pid?, tmuxSession?}` → present with an active run
 *   - unreadable metadata with no exact match throws (ownership is unknown)
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { listOwnedSessionLifecycles } from './owned-session-lifecycle';
import { archiveRootForOwnedSessionRoot } from './owned-session/archive';
import { readOwnedSessionMetadata } from './owned-session/metadata-read';
import type { OwnedSessionRecord } from './owned-session/types';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import type { OwnedIdentitySource } from './owned-session/process-identity';
import type { SupervisorReference } from '@/lib/runtime/o8d-supervisor';

export interface OwnedActiveRun {
  id?: string;
  supervisor?: SupervisorReference;
  pid?: number;
  processIdentity?: MetadataLockProcessIdentity;
  processIdentitySource?: OwnedIdentitySource;
  processIdentityRequired?: boolean;
  detachMode?: 'detached' | 'bridge';
  processGroupId?: number;
  tmuxSession?: string;
  commandIdentity?: string;
  processMarker?: string;
}

export interface IndexedOwnedActiveRun extends OwnedActiveRun {
  surfaceId: string;
}

export interface OwnedLaunchMutationMatch {
  surfaceId: string;
  cwd: string;
  repoPath: string;
  laneId?: string;
  packetId?: string;
  outcome: 'running' | 'finished' | 'interrupted' | 'failed';
}

export interface OwnedSessionDisplay {
  sessionKey: string;
  name: string;
  model: string | null;
  runtime: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'idle' | 'retired';
}

/** Resolve the owned roots FRESH per call — env may be set after import (tests),
 *  and the resolution is cheap. */
export function ownedRoots(): ReadonlyArray<{ marker: string; root: string }> {
  const roots = [
    {
      marker: 'codex-owned:',
      root: process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(getDataDir(), 'owned-codex'),
    },
    {
      marker: 'claude-code-owned:',
      root: process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT || path.join(getDataDir(), 'owned-claude-code'),
    },
    {
      marker: 'gemini-owned:',
      root: process.env.O8_OWNED_GEMINI_ROOT || path.join(getDataDir(), 'owned-gemini'),
    },
    {
      marker: 'opencode-owned:',
      root: process.env.O8_OWNED_OPENCODE_ROOT || path.join(getDataDir(), 'owned-opencode'),
    },
    {
      marker: 'cursor-owned:',
      root: process.env.O8_OWNED_CURSOR_ROOT || path.join(getDataDir(), 'owned-cursor'),
    },
    {
      marker: 'grok-owned:',
      root: process.env.O8_OWNED_GROK_ROOT || path.join(getDataDir(), 'owned-grok'),
    },
    {
      marker: 'prime-agent-owned:',
      root: process.env.O8_OWNED_PRIME_AGENT_ROOT || path.join(getDataDir(), 'owned-prime-agent'),
    },
    {
      marker: 'pi-owned:',
      root: process.env.O8_OWNED_PI_ROOT || path.join(getDataDir(), 'owned-pi'),
    },
  ];
  const seen = new Set(roots.map((entry) => entry.marker));
  for (const lifecycle of listOwnedSessionLifecycles()) {
    if (seen.has(lifecycle.surfaceIdPrefix)) continue;
    roots.push({ marker: lifecycle.surfaceIdPrefix, root: lifecycle.resolveRoot() });
    seen.add(lifecycle.surfaceIdPrefix);
  }
  return roots;
}

/** Exact read-only lookup, including archives; never creates a live session root. */
export async function readOwnedSessionRecord(surfaceId: string): Promise<OwnedSessionRecord | null> {
  const root = ownedRoots().find((entry) => surfaceId.startsWith(entry.marker));
  if (!root) return null;
  const directory = surfaceId.slice(root.marker.length);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(directory)) return null;

  for (const base of [root.root, archiveRootForOwnedSessionRoot(root.root)]) {
    let parsed: OwnedSessionRecord;
    try {
      parsed = await readOwnedSessionMetadata(path.join(base, directory, 'session.json'));
    } catch {
      continue;
    }
    if (parsed.surfaceId !== surfaceId) continue;
    return parsed;
  }
  return null;
}

/** Resolve a pane's identity after its owned session leaves the live fleet. */
export async function readOwnedSessionDisplay(surfaceId: string): Promise<OwnedSessionDisplay | null> {
  const parsed = await readOwnedSessionRecord(surfaceId);
  if (!parsed) return null;
  const runtime = surfaceId.slice(0, surfaceId.indexOf('-owned:'));
  const outcome = Array.isArray(parsed.recentRuns)
    ? [...parsed.recentRuns].sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))[0]?.outcome
    : null;
  const status = parsed.retiredAt ? 'retired' : parsed.activeRun ? 'running'
    : outcome === 'finished' ? 'completed'
      : outcome === 'failed' ? 'failed'
        : outcome === 'interrupted' ? 'interrupted'
          : 'idle';
  return {
    sessionKey: surfaceId,
    name: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 120)
      : runtime,
    model: typeof parsed.model === 'string' && parsed.model.trim()
      ? parsed.model.trim().slice(0, 120) : null,
    runtime,
    status,
  };
}

const INDEX_TTL_MS = 2_000;

/** Per-root memo: surfaceId → activeRun (or {} when cleared). */
interface RootIndex {
  runs: Map<string, OwnedActiveRun>;
  unreadable: boolean;
}
const rootCache = new Map<string, { builtAt: number; index: RootIndex }>();

async function buildRootIndex(root: string): Promise<RootIndex> {
  const index: RootIndex = { runs: new Map(), unreadable: false };
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    index.unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    return index;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const metadataPath = path.join(root, entry.name, 'session.json');
    let parsed: { surfaceId?: string; packetId?: string; activeRun?: OwnedActiveRun };
    try {
      parsed = await readOwnedSessionMetadata(metadataPath);
      if (!parsed || typeof parsed.surfaceId !== 'string') throw new Error('Missing owned session identity.');
    } catch {
      index.unreadable = true;
      return;
    }
    index.runs.set(parsed.surfaceId, parsed.activeRun
      ? {
          id: typeof parsed.activeRun.id === 'string' ? parsed.activeRun.id : undefined,
          supervisor: parsed.activeRun.supervisor,
          pid: typeof parsed.activeRun.pid === 'number' ? parsed.activeRun.pid : undefined,
          processIdentity: parsed.activeRun.processIdentity,
          processIdentitySource: parsed.activeRun.processIdentitySource,
          ...((parsed.activeRun.processIdentityRequired || (parsed.activeRun.processIdentityRequired !== false && process.platform !== 'win32'
            && (parsed.surfaceId.startsWith('codex-owned:') || parsed.activeRun.detachMode === 'detached')
            && Boolean(parsed.packetId) && !parsed.activeRun.tmuxSession))
            ? { processIdentityRequired: true } : {}),
          processGroupId: typeof parsed.activeRun.processGroupId === 'number'
            ? parsed.activeRun.processGroupId
            : undefined,
          tmuxSession: typeof parsed.activeRun.tmuxSession === 'string' ? parsed.activeRun.tmuxSession : undefined,
          commandIdentity: typeof parsed.activeRun.commandIdentity === 'string'
            ? parsed.activeRun.commandIdentity
            : undefined,
          processMarker: typeof parsed.activeRun.processMarker === 'string'
            ? parsed.activeRun.processMarker
            : undefined,
        }
      : {});
  }));
  return index;
}

async function getRootIndex(root: string, now: number): Promise<RootIndex> {
  const cached = rootCache.get(root);
  if (cached && now - cached.builtAt < INDEX_TTL_MS) return cached.index;
  const index = await buildRootIndex(root);
  rootCache.set(root, { builtAt: now, index });
  return index;
}

function indexedRun(index: RootIndex, surfaceId: string): OwnedActiveRun | null {
  const run = index.runs.get(surfaceId);
  if (run) return run;
  // An unreadable sibling must not block a known session, but it also cannot
  // prove that a missing identity is quiescent. Liveness callers fail closed.
  if (index.unreadable) throw new Error('Owned session liveness unavailable: unreadable metadata.');
  return null;
}

/**
 * Resolve a lane's owned active run, sharing a per-root scan across all callers
 * within the TTL. Returns `null` when the surfaceId is not present under its
 * matching root; `{}` when present-but-cleared; the run otherwise.
 */
export async function lookupOwnedActiveRun(surfaceId: string, now: number = Date.now()): Promise<OwnedActiveRun | null> {
  const match = ownedRoots().find((r) => surfaceId.startsWith(r.marker));
  if (!match) return null;
  const index = await getRootIndex(match.root, now);
  return indexedRun(index, surfaceId);
}

/** Safety-critical lookup that bypasses the short fleet cache before a kill. */
export async function lookupOwnedActiveRunFresh(surfaceId: string): Promise<OwnedActiveRun | null> {
  const match = ownedRoots().find((root) => surfaceId.startsWith(root.marker));
  if (!match) return null;
  const index = await buildRootIndex(match.root);
  rootCache.set(match.root, { builtAt: Date.now(), index });
  return indexedRun(index, surfaceId);
}

/** List every owned session whose persisted metadata still carries an active run. */
export async function listOwnedActiveRuns(now: number = Date.now(), fresh = false): Promise<IndexedOwnedActiveRun[]> {
  const indexes = await Promise.all(ownedRoots().map(({ root }) => fresh ? buildRootIndex(root) : getRootIndex(root, now)));
  if (fresh && indexes.some(index => index.unreadable)) throw new Error('Owned session inventory is unavailable.');
  const active = new Map<string, IndexedOwnedActiveRun>();
  for (const index of indexes) {
    for (const [surfaceId, run] of index.runs) {
      if (run.pid !== undefined || run.tmuxSession !== undefined) active.set(surfaceId, { surfaceId, ...run });
    }
  }
  return [...active.values()];
}

/**
 * Recover an o8-owned launch after the server died before receipt finalization.
 * The marker is written into session.json before spawn, so a match proves that
 * this exact mutation crossed the owned launch boundary.
 */
export async function findOwnedLaunchByMutationId(
  clientMutationId: string,
): Promise<OwnedLaunchMutationMatch | null> {
  // Finished workers may already have been archived by the time the lead
  // submits its review receipt. Search both roots for the exact launch marker.
  for (const root of ownedRoots().flatMap(({ root }) => [root, archiveRootForOwnedSessionRoot(root)])) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed = await readOwnedSessionMetadata<Partial<OwnedLaunchMutationMatch> & {
          launchMutationId?: unknown;
          activeRun?: { outcome?: unknown };
          recentRuns?: Array<{ outcome?: unknown }>;
        }>(path.join(root, entry.name, 'session.json'));
        if (parsed.launchMutationId !== clientMutationId
          || typeof parsed.surfaceId !== 'string'
          || typeof parsed.cwd !== 'string'
          || typeof parsed.repoPath !== 'string') continue;
        const rawOutcome = parsed.activeRun?.outcome ?? parsed.recentRuns?.[0]?.outcome;
        if (rawOutcome !== 'running' && rawOutcome !== 'finished'
          && rawOutcome !== 'interrupted' && rawOutcome !== 'failed') continue;
        return {
          surfaceId: parsed.surfaceId,
          cwd: parsed.cwd,
          repoPath: parsed.repoPath,
          laneId: typeof parsed.laneId === 'string' ? parsed.laneId : undefined,
          packetId: typeof parsed.packetId === 'string' ? parsed.packetId : undefined,
          outcome: rawOutcome,
        };
      } catch {
        // One corrupt session must not hide a valid correlated session.
      }
    }
  }
  return null;
}

/** Test-only: drop the memo so a test's fs writes are read fresh. */
export function resetOwnedSessionIndex(): void {
  rootCache.clear();
}
