import 'server-only';

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { IndexState } from './types';

function statePath(): string {
  // Injecting the environment selects pure resolution, without migration.
  return join(getDataDir({ ...process.env }), 'codebase-memory-live.json');
}

/** Called only by the existing Next startup indexer, on every transition. */
export function publishIndexState(state: IndexState): void {
  try {
    mkdirSync(getDataDir({ ...process.env }), { recursive: true });
    const path = statePath();
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, ...state }));
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
      return { bootRan: state.bootRan, inFlight: state.inFlight, entries: state.entries };
    }
  } catch { /* A cold directory has no owner snapshot yet. */ }
  return { bootRan: false, inFlight: false, entries: [] };
}
