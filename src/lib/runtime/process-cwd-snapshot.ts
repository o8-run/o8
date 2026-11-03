import { execFile } from '@/lib/providers/child-process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { closeObservedHelperSettled, hasCloseProcessObservation, observeCloseProcess, refreshCloseProcessObservation } from './close-process-observation';
import { parseOpenFileSnapshot, readCloseOpenFileRows } from './process-open-files-snapshot';
import { missingLinuxLsof, readProcOpenFiles } from './proc-open-files-snapshot';

const execFileAsync = promisify(execFile);
const ACTIVE_SNAPSHOT_TTL_MS = 15_000;
const IDLE_SNAPSHOT_TTL_MS = 30_000;

export interface ProcessCwdRow {
  pid: number;
  cwd: string;
  commandName?: string;
}

export type ProcessCwdSnapshot =
  | { status: 'ready'; rows: ProcessCwdRow[]; capturedAt: number }
  | { status: 'unavailable'; rows: []; capturedAt: number; reason: string };

interface ProcessCwdCommandResult {
  stdout: string | Buffer;
}

export type ProcessCwdExecFile = (
  file: string,
  args: string[],
  options: {
    windowsHide: boolean;
    maxBuffer: number;
    timeout: number;
  },
) => Promise<ProcessCwdCommandResult>;

export interface ProcessCwdSnapshotOptions {
  /** Deterministic process seam for real-path tests. */
  execFile?: ProcessCwdExecFile;
  now?: () => number;
  /** Destructive boundaries must not rely on the inventory cache. */
  forceRefresh?: boolean;
}

export interface ProcessCwdProbeDiagnostics {
  lsofInvocations: number;
  cacheHits: number;
  singleFlightJoins: number;
  emptyRequestSkips: number;
  failures: number;
  inflight: boolean;
  lastProbeAt: number | null;
  lastDurationMs: number | null;
  lastRowCount: number;
}

let cachedSnapshot: { value: ProcessCwdSnapshot; expiresAt: number } | null = null;
let snapshotInflight: Promise<ProcessCwdSnapshot> | null = null;
let lsofInvocations = 0;
let cacheHits = 0;
let singleFlightJoins = 0;
let emptyRequestSkips = 0;
let failures = 0;
let lastProbeAt: number | null = null;
let lastDurationMs: number | null = null;
let lastRowCount = 0;

function outputText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

export function parseProcessCwdSnapshot(raw: string): ProcessCwdRow[] {
  const rows: ProcessCwdRow[] = [];
  let current: Partial<ProcessCwdRow> = {};

  const flush = () => {
    if (typeof current.pid === 'number' && current.cwd) {
      rows.push(current as ProcessCwdRow);
    }
    current = {};
  };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      flush();
      const pid = Number(value);
      if (Number.isFinite(pid)) current.pid = pid;
    } else if (tag === 'c') {
      current.commandName = value;
    } else if (tag === 'n') {
      current.cwd = value;
    }
  }
  flush();
  return rows;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 300) || 'unknown lsof failure';
}

function defaultExecFile(
  file: string,
  args: string[],
  options: Parameters<ProcessCwdExecFile>[2],
): Promise<ProcessCwdCommandResult> {
  return execFileAsync(file, args, options);
}

/**
 * Read one machine-wide cwd snapshot. Inventory callers share the cache and
 * in-flight promise. Forced reads wait for preceding scans, then take their own
 * fresh evidence without overlapping lsof processes.
 */
export async function readProcessCwdSnapshot(
  options: ProcessCwdSnapshotOptions = {},
): Promise<ProcessCwdSnapshot> {
  // A forced destructive-boundary read must replace every shared projection,
  // including prior helper settlement, rather than returning a cached cwd.
  if (options.forceRefresh) refreshCloseProcessObservation();
  const snapshot = await observeCloseProcess('cwd', async (): Promise<ProcessCwdSnapshot> => {
    if (!hasCloseProcessObservation() || options.execFile) return readNativeProcessCwdSnapshot(options);
    const capturedAt = Date.now();
    try {
      // Linux's full-file listing can repeat a process's cwd for its tasks.
      // Collapse only identical observations. Conflicting cwd records remain
      // visible, so exact-helper attestation still requires one unique cwd.
      const seen = new Set<string>();
      const rows = (await readCloseOpenFileRows())
        .filter(row => row.descriptor === 'cwd')
        .filter(row => {
          const key = JSON.stringify([row.pid, row.file]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(row => {
          if (!path.isAbsolute(row.file)) throw new Error('Native cwd has no absolute namespace.');
          return { pid: row.pid, cwd: row.file, commandName: row.commandName };
        });
      return { status: 'ready', rows, capturedAt };
    } catch { return { status: 'unavailable', rows: [], capturedAt, reason: 'Native open-file snapshot is unavailable or inconclusive.' }; }
  });
  return snapshot.status === 'ready'
    ? { ...snapshot, rows: snapshot.rows.filter(row => !closeObservedHelperSettled(row.pid)) } : snapshot;
}

async function readNativeProcessCwdSnapshot(options: ProcessCwdSnapshotOptions): Promise<ProcessCwdSnapshot> {
  const now = options.now ?? Date.now;
  const requestedAt = now();
  if (!options.forceRefresh && cachedSnapshot && requestedAt < cachedSnapshot.expiresAt) {
    cacheHits += 1;
    return cachedSnapshot.value;
  }
  while (snapshotInflight) {
    if (!options.forceRefresh) {
      singleFlightJoins += 1;
      return snapshotInflight;
    }
    // An older scan may predate a new holder. Settle it without consuming its
    // evidence, and recheck in case another forced caller started the next scan.
    await snapshotInflight;
  }

  const run = options.execFile ?? defaultExecFile;
  const startedAt = now();
  lsofInvocations += 1;
  lastProbeAt = startedAt;
  const promise = (async (): Promise<ProcessCwdSnapshot> => {
    let snapshot: ProcessCwdSnapshot;
    try {
      const { stdout } = await run('lsof', ['-nP', '-d', 'cwd', '-F', 'pcn'], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 3_000,
      });
      const rows = parseProcessCwdSnapshot(outputText(stdout));
      snapshot = { status: 'ready', rows, capturedAt: startedAt };
      lastRowCount = rows.length;
    } catch (error) {
      try {
        if (!missingLinuxLsof(error)) throw error;
        const rows = parseOpenFileSnapshot(await readProcOpenFiles())
          .filter(row => row.descriptor === 'cwd')
          .map(row => ({ pid: row.pid, cwd: row.file, commandName: row.commandName }));
        snapshot = { status: 'ready', rows, capturedAt: startedAt };
        lastRowCount = rows.length;
      } catch (failure) {
        failures += 1;
        lastRowCount = 0;
        snapshot = {
          status: 'unavailable', rows: [], capturedAt: startedAt, reason: compactError(failure),
        };
      }
    }

    lastDurationMs = Math.max(0, now() - startedAt);
    const ttlMs = snapshot.status === 'ready' && snapshot.rows.length > 0
      ? ACTIVE_SNAPSHOT_TTL_MS
      : IDLE_SNAPSHOT_TTL_MS;
    cachedSnapshot = { value: snapshot, expiresAt: now() + ttlMs };
    return snapshot;
  })();

  snapshotInflight = promise;
  try {
    return await promise;
  } finally {
    if (snapshotInflight === promise) snapshotInflight = null;
  }
}

/** Skip lsof entirely when a caller has no candidate process IDs. */
export async function readProcessCwdsForPids(
  pids: number[],
  options: ProcessCwdSnapshotOptions = {},
): Promise<Map<number, string>> {
  const wanted = new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (wanted.size === 0) {
    emptyRequestSkips += 1;
    return new Map();
  }
  const snapshot = await readProcessCwdSnapshot(options);
  if (snapshot.status !== 'ready') return new Map();
  return new Map(
    snapshot.rows
      .filter((row) => wanted.has(row.pid))
      .map((row) => [row.pid, row.cwd]),
  );
}

function canonicalCwdPath(candidate: string): string {
  try {
    return realpathSync.native(candidate).replace(/\/+$/, '');
  } catch {
    return path.resolve(candidate).replace(/\/+$/, '');
  }
}

/** Match cwd rows through filesystem aliases such as macOS `/var` → `/private/var`. */
export function processCwdRowsInside(
  snapshot: ProcessCwdSnapshot,
  dirPath: string,
): ProcessCwdRow[] {
  if (snapshot.status !== 'ready') return [];
  const target = canonicalCwdPath(dirPath);
  return snapshot.rows.filter((row) => {
    const cwd = canonicalCwdPath(row.cwd);
    return cwd === target || cwd.startsWith(`${target}${path.sep}`);
  });
}

/** Reaper-only fail-closed view of the shared cwd snapshot. */
export async function hasLiveProcessCwdInside(dirPath: string): Promise<boolean> {
  const target = path.resolve(dirPath).replace(/\/+$/, '');
  if (!target || target === path.parse(target).root) return true;
  const snapshot = await readProcessCwdSnapshot();
  if (snapshot.status !== 'ready') return true;
  return processCwdRowsInside(snapshot, target).length > 0;
}

export function readProcessCwdProbeDiagnostics(): ProcessCwdProbeDiagnostics {
  return {
    lsofInvocations,
    cacheHits,
    singleFlightJoins,
    emptyRequestSkips,
    failures,
    inflight: snapshotInflight !== null,
    lastProbeAt,
    lastDurationMs,
    lastRowCount,
  };
}

export function invalidateProcessCwdSnapshot(): void {
  cachedSnapshot = null;
}

export function resetProcessCwdProbeForTesting(): void {
  cachedSnapshot = null;
  snapshotInflight = null;
  lsofInvocations = 0;
  cacheHits = 0;
  singleFlightJoins = 0;
  emptyRequestSkips = 0;
  failures = 0;
  lastProbeAt = null;
  lastDurationMs = null;
  lastRowCount = 0;
}
