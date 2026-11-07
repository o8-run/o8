import 'server-only';

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import type { IndexState } from './types';

export const INDEX_STATE_PUBLISH_INTERVAL_MS = 5_000;
let cleanedDirectory: string | undefined;

function statePath(): string {
  // Injecting the environment selects pure resolution, without migration.
  return join(getDataDir({ ...process.env }), 'codebase-memory-live.json');
}

/** Called only by the existing Next startup indexer, on transitions and heartbeats. */
export function publishIndexState(state: IndexState): void {
  try {
    const directory = getDataDir({ ...process.env });
    mkdirSync(directory, { recursive: true });
    if (cleanedDirectory !== directory) {
      for (const name of readdirSync(directory)) {
        if (/^codebase-memory-live\.json\.\d+\.tmp$/.test(name)) rmSync(join(directory, name), { force: true });
      }
      cleanedDirectory = directory;
    }
    const path = statePath();
    const temporary = `${path}.${process.pid}.tmp`;
    const owner = probeMetadataLockProcessIdentitySync(process.pid);
    writeFileSync(temporary, JSON.stringify({ version: 1, ...state, ownerPid: process.pid,
      ownerIdentity: owner.state === 'live' ? owner.identity : undefined, updatedAt: Date.now() }));
    renameSync(temporary, path);
  } catch {
    console.warn('[codebase-memory] Could not publish live state.');
  }
}

/** Both transports read the owner's latest complete snapshot on every GET. */
export function readIndexState(): IndexState {
  try {
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (state.version === 1 && typeof state.bootRan === 'boolean'
      && typeof state.inFlight === 'boolean' && Array.isArray(state.entries)) {
      if (state.inFlight || state.entries.some((entry: IndexState['entries'][number]) => entry.status === 'pending' || entry.status === 'indexing')) {
        let reason: string | undefined;
        if (!Number.isFinite(state.updatedAt) || Date.now() - state.updatedAt > 2 * INDEX_STATE_PUBLISH_INTERVAL_MS) {
          reason = 'Stale index state: owner heartbeat expired.';
        } else if (!Number.isSafeInteger(state.ownerPid) || state.ownerPid <= 0) {
          reason = 'Stale index state: owner is unknown.';
        } else {
          const owner = probeMetadataLockProcessIdentitySync(state.ownerPid);
          if (owner.state === 'absent') reason = 'Stale index state: owner stopped.';
          else if (owner.state === 'live' && isMetadataLockProcessIdentity(state.ownerIdentity)
            && !sameMetadataLockProcessIdentity(owner.identity, state.ownerIdentity)) {
            reason = 'Stale index state: owner restarted.';
          }
        }
        if (reason) return { bootRan: state.bootRan, inFlight: false,
          entries: state.entries.map((entry: IndexState['entries'][number]) => entry.status === 'pending' || entry.status === 'indexing'
            ? { ...entry, status: 'error', error: reason } : entry) };
      }
      return { bootRan: state.bootRan, inFlight: state.inFlight, entries: state.entries };
    }
  } catch { /* A cold directory has no owner snapshot yet. */ }
  return { bootRan: false, inFlight: false, entries: [] };
}
