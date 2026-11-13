import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

interface Observation {
  active: boolean;
  startedAt: number;
  values: Map<string, Promise<unknown>>;
  scans: { openFiles: number; cwdProjections: number };
  settled: Set<number>;
}
const observation = new AsyncLocalStorage<Observation>();

/** Evidence belongs to one close and one phase, never to inventory or a retry. */
export async function withCloseProcessObservation<T>(operation: () => Promise<T>): Promise<T> {
  const state: Observation = { active: true, startedAt: performance.now(), values: new Map(), settled: new Set(), scans: { openFiles: 0, cwdProjections: 0 } };
  try { return await observation.run(state, operation); }
  finally { state.active = false; state.values.clear(); }
}

export function refreshCloseProcessObservation(): void {
  const state = observation.getStore();
  if (state?.active) { state.values.clear(); state.settled.clear(); state.startedAt = performance.now(); }
}

export function closeProcessScanCounts(): { openFiles: number; cwdProjections: number } | null {
  const state = observation.getStore();
  return state?.active ? { ...state.scans } : null;
}

export function observeCloseProcess<T>(key: string, read: () => Promise<T>): Promise<T> {
  const state = observation.getStore();
  if (!state?.active) return read();
  if (performance.now() - state.startedAt > 30_000) throw new Error('Close process observation exceeded its phase deadline.');
  const existing = state.values.get(key);
  if (existing) return existing as Promise<T>;
  if (key === 'open-files' || key === 'open-files-retry') state.scans.openFiles += 1;
  if (key === 'cwd') state.scans.cwdProjections += 1;
  const value = Promise.resolve().then(read);
  state.values.set(key, value);
  return value;
}

/** Only an observed close of this attempt's birth-attested helper settles its snapshot row. */
export function settleCloseObservedHelper(pid: number): void {
  const state = observation.getStore();
  if (state?.active) state.settled.add(pid);
}

export function closeObservedHelperSettled(pid: number): boolean {
  const state = observation.getStore();
  return state?.active === true && state.settled.has(pid);
}

export function hasCloseProcessObservation(): boolean { return observation.getStore()?.active === true; }
