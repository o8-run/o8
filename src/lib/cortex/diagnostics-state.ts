import 'server-only';

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isNativeCortexReader } from './owner-process';
import { setProcessCwdProbeDiagnosticsObserver, type ProcessCwdProbeDiagnostics } from '@/lib/runtime/process-cwd-snapshot';

const emptyProbe: ProcessCwdProbeDiagnostics = {
  lsofInvocations: 0, cacheHits: 0, singleFlightJoins: 0, emptyRequestSkips: 0,
  failures: 0, inflight: false, lastProbeAt: null, lastDurationMs: null, lastRowCount: 0,
};
let lastPublished: { path: string; contents: string } | undefined;

function probePath(): string {
  return join(getDataDir({ ...process.env }), 'cortex-process-cwd.json');
}

/** Next startup is the sole publisher of the probe counters shown by both GETs. */
export function startCortexDiagnosticsPublisher(): void {
  if (isNativeCortexReader()) return;
  setProcessCwdProbeDiagnosticsObserver(probe => {
    try {
      const path = probePath();
      const contents = JSON.stringify({ version: 1, probe });
      if (lastPublished?.path === path && lastPublished.contents === contents) return;
      const directory = getDataDir({ ...process.env });
      mkdirSync(directory, { recursive: true });
      if (lastPublished?.path !== path) {
        for (const name of readdirSync(directory)) {
          if (/^cortex-process-cwd\.json\.\d+\.tmp$/.test(name)) rmSync(join(directory, name), { force: true });
        }
      }
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, contents);
      renameSync(temporary, path);
      lastPublished = { path, contents };
    } catch {
      console.warn('[cortex-diagnostics] Could not publish probe counters.');
    }
  });
}

export function readPersistedProcessCwdProbeDiagnostics(): ProcessCwdProbeDiagnostics {
  try {
    const value = JSON.parse(readFileSync(probePath(), 'utf8'));
    if (value.version === 1 && value.probe && Object.keys(emptyProbe).every(key => key in value.probe)) return value.probe;
  } catch { /* No owner snapshot on a cold data directory. */ }
  return { ...emptyProbe };
}
