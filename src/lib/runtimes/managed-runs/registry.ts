/**
 * Registry for `o8 run` managed sessions.
 *
 * In-process (globalThis singleton — survives Next route-module re-instantiation)
 * and disk-backed at `<dataDir>/managed-runs.json` (atomic, merge-on-write) so it
 * survives a Next *process* restart (every auto-update) and tolerates a second
 * Next process (dev-bridge) without dropping the other process's runs. The tmux
 * server outlives Next, so a hydrated record's `panePid` stays usable for port
 * attribution until the next reconcile against `tmux ls` flips dead sessions away.
 *
 * One primary process serves the UI; the ws-server does not read this.
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
import { listCortexTmuxSessions } from '@/lib/terminal/tmux';
import { getDataDir } from '@/lib/data-dir-migration';
import type {
  ManagedRunRecord,
  ManagedRunStatus,
  ManagedRunTerminationReceipt,
  ManagedRunSettlementReceipt,
} from './types';
import { externalSettlementQuiet, validProviderSessionId } from './settlement';
import { inspectOwnedManagedRun } from './termination';
import { resolveManagedRunExitReceipt } from './receipt-path';
import { managedRunReceiptIo } from './receipt-io';

/** keep at most this many records (running always kept; oldest terminal dropped) */
const RETENTION = 50;
const VALID_STATUS: ReadonlySet<string> = new Set<ManagedRunStatus>(['running', 'settling', 'finished', 'gone', 'killed']);

const store = globalThis as typeof globalThis & {
  __o8ManagedRuns?: Map<string, ManagedRunRecord>;
  __o8ManagedRunsHydrated?: boolean;
};
const runs = store.__o8ManagedRuns ?? new Map<string, ManagedRunRecord>();
store.__o8ManagedRuns = runs;

// newest-first; tolerant of a missing startedAt so one malformed record can
// never throw inside the comparator and poison the whole list.
function byStartedDesc(a: ManagedRunRecord, b: ManagedRunRecord): number {
  return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
}

/** Structural guard for persisted records — drop anything that would break sorts/reads. */
function isValidRecord(rec: unknown): rec is ManagedRunRecord {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.session === 'string' && r.session.startsWith('cortex-run-')
    && typeof r.command === 'string'
    && typeof r.cwd === 'string'
    && typeof r.startedAt === 'string' && r.startedAt.length > 0
    && typeof r.status === 'string' && VALID_STATUS.has(r.status);
}

// ── Persistence ──

function runsFile(): string {
  return join(getDataDir(), 'managed-runs.json');
}

/** Cap the persisted set: always keep running runs, then the newest terminals. */
function capForPersist(list: ManagedRunRecord[]): ManagedRunRecord[] {
  if (list.length <= RETENTION) return list;
  const running = list.filter((r) => r.status === 'running' || r.status === 'settling' || r.settlement);
  const terminal = list.filter((r) => !running.includes(r)).sort(byStartedDesc);
  return [...running, ...terminal.slice(0, Math.max(0, RETENTION - running.length))];
}

/**
 * Atomic, merge-on-write best-effort persist. Unions our in-memory view with
 * whatever is on disk (a second process — e.g. dev-bridge — may hold runs this
 * process never saw), in-memory winning per session, so no process clobbers
 * another's runs. Never blocks the registry.
 */
function persist(required = false, expected?: { session: string; record: ManagedRunRecord | null }): void {
  let locked = false;
  const lock = `${runsFile()}.lock`;
  try {
    const file = runsFile();
    mkdirSync(getDataDir(), { recursive: true });
    // Bounded fail-closed CAS across server processes. Never break a lock whose
    // owner may still be writing; a stale lock needs operator reconciliation.
    mkdirSync(lock);
    locked = true;
    const merged = new Map<string, ManagedRunRecord>();
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: unknown[] };
        for (const rec of parsed.runs ?? []) {
          if (isValidRecord(rec)) merged.set(rec.session, rec);
        }
      }
    } catch (error) { if (required) throw error; }
    if (expected && JSON.stringify(merged.get(expected.session) ?? null) !== JSON.stringify(expected.record)) {
      throw new Error('managed_run_persistence_conflict');
    }
    if (expected?.record === null) {
      const proposed = runs.get(expected.session)?.settlement?.binding;
      if (proposed && [...merged.values()].some((r) => (
        r.settlement?.binding.executionKey === proposed.executionKey
        && r.settlement?.binding.generation === proposed.generation
      ))) throw new Error('managed_run_execution_conflict');
    }
    for (const [session, rec] of runs) {
      // Ordinary run reconciliation must not overwrite a newer host receipt.
      if (!merged.get(session)?.settlement || expected?.session === session) merged.set(session, rec);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: capForPersist([...merged.values()]) }), 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    if (required) throw new Error('managed_run_persistence_unavailable', { cause: error });
  } finally {
    if (locked) rmdirSync(lock);
  }
}

/**
 * Recover a run's exit code from the pane wrapper's durable exit receipt.
 * Signal receipts map to their conventional shell exit codes. Returns null
 * while a live run has not written its receipt or for an unknown signal.
 */
function readExitCode(rec: ManagedRunRecord): number | null {
  try {
    const raw = managedRunReceiptIo(rec)?.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const signal = raw.match(/^signal:(HUP|INT|QUIT|KILL|TERM)$/)?.[1];
    if (!signal) return null;
    const number = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15 }[signal];
    return number === undefined ? null : 128 + number;
  } catch {
    return null;
  }
}

function retainUnknownExitReceipt(rec: ManagedRunRecord): void {
  managedRunReceiptIo(rec, true);
}

/** Load persisted records on first module init (per process), validating each. */
function hydrate(): void {
  if (store.__o8ManagedRunsHydrated) return;
  store.__o8ManagedRunsHydrated = true;
  try {
    const file = runsFile();
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: unknown[] };
    for (const rec of parsed.runs ?? []) {
      if (isValidRecord(rec) && !runs.has(rec.session)) runs.set(rec.session, rec);
    }
  } catch { /* missing/corrupt — start empty */ }
}
hydrate();

// ── Mutations ──

export function registerManagedRun(rec: ManagedRunRecord, requirePersistence = false): ManagedRunRecord {
  if (rec.exitReceiptPath !== undefined && !resolveManagedRunExitReceipt(rec.id, rec.exitReceiptPath)) {
    throw new Error('invalid_exit_receipt_path');
  }
  const existing = findManagedRun(rec.id) ?? findManagedRun(rec.session);
  if (existing) {
    const identity = (r: ManagedRunRecord) => JSON.stringify([
      r.id, r.session, r.command, r.title ?? null, r.cwd, r.repo ?? null,
      r.packetId ?? null, r.laneId ?? null, r.panePid ?? null,
      r.processGroupId ?? null, r.processMarker ?? null, r.mode,
      r.exitReceiptPath ?? null, r.workspaceService ?? null,
      r.settlement?.binding ?? null,
    ]);
    if (identity(existing) !== identity(rec)) throw new Error('managed_run_registration_conflict');
    return existing;
  }
  if (rec.settlement && [...runs.values()].some((r) => (
    r.settlement?.binding.executionKey === rec.settlement?.binding.executionKey
    && r.settlement?.binding.generation === rec.settlement?.binding.generation
  ))) throw new Error('managed_run_execution_conflict');
  runs.set(rec.session, rec);
  prune();
  try { persist(requirePersistence || Boolean(rec.settlement), requirePersistence || rec.settlement ? { session: rec.session, record: null } : undefined); }
  catch (error) { runs.delete(rec.session); throw error; }
  return rec;
}

export function findManagedRun(idOrSession: string): ManagedRunRecord | null {
  // Host callbacks and a second server can advance settlement between probes.
  try {
    const parsed = JSON.parse(readFileSync(runsFile(), 'utf8')) as { runs?: unknown[] };
    for (const rec of parsed.runs ?? []) if (isValidRecord(rec) && rec.settlement) runs.set(rec.session, rec);
  } catch { /* a durable mutation still fails closed if storage cannot be read */ }
  return runs.get(idOrSession) ?? [...runs.values()].find((run) => run.id === idOrSession) ?? null;
}

/**
 * Mark a run finished. Idempotent + monotonic: a terminal record is never
 * re-stamped or downgraded; a real exit code may only UPGRADE a record whose
 * code is still unknown (e.g. reconcile recorded `gone`, then the stream CLI's
 * finish POST lands with the real code). A null code never clobbers a known one.
 */
export function finishManagedRun(
  idOrSession: string,
  exitCode: number | null,
  ownedQuiet = false,
): ManagedRunRecord | null {
  const rec = findManagedRun(idOrSession);
  if (!rec) return null;
  if (rec.settlement && rec.status !== 'running' && rec.status !== 'settling') return rec;
  if (rec.settlement && (rec.status === 'running' || rec.status === 'settling')) {
    return updateBoundRun(rec, (next) => {
      next.settlement!.wrapperFinished = true;
      if (exitCode !== null) next.exitCode = exitCode;
      if (externalSettlementQuiet(next) && ownedQuiet && !next.settlement!.stopRequestId) {
        next.status = 'finished';
        next.finishedAt = new Date().toISOString();
      } else {
        next.status = 'settling';
        next.finishedAt = null;
      }
    });
  }
  if (rec.status !== 'running') {
    if (exitCode !== null && rec.exitCode === null) {
      rec.exitCode = exitCode;
      rec.status = 'finished';
      persist();
    }
    return rec;
  }
  rec.status = 'finished';
  rec.exitCode = exitCode;
  rec.finishedAt = new Date().toISOString();
  persist();
  return rec;
}

/** Mark a run killed by the operator (only a still-running record transitions). */
export function killManagedRun(
  session: string,
  exitCode: number | null,
  termination: ManagedRunTerminationReceipt,
): ManagedRunRecord | null {
  const rec = findManagedRun(session);
  if (!rec) return null;
  if (!termination.confirmedDead || !externalSettlementQuiet(rec)) return rec;
  if (rec.settlement && (rec.status === 'running' || rec.status === 'settling' || rec.status === 'gone')) {
    return updateBoundRun(rec, (next) => {
      next.status = 'killed'; next.finishedAt = new Date().toISOString();
      next.exitCode = exitCode; next.termination = termination;
    });
  }
  if (rec.status === 'running' || rec.status === 'settling' || rec.status === 'gone') {
    rec.status = 'killed';
    rec.finishedAt = new Date().toISOString();
    rec.exitCode = exitCode;
    rec.termination = termination;
    persist(Boolean(rec.settlement));
  }
  return rec;
}

/** Bound state changes persist or roll back; an in-memory receipt is insufficient. */
function updateBoundRun(rec: ManagedRunRecord, mutate: (next: ManagedRunRecord) => void): ManagedRunRecord {
  const next = structuredClone(rec);
  mutate(next);
  runs.set(next.session, next);
  try { persist(true, { session: rec.session, record: rec }); }
  catch (error) { runs.set(rec.session, rec); throw error; }
  return next;
}

export function requestManagedRunStop(id: string): ManagedRunRecord | null {
  const rec = findManagedRun(id);
  if (!rec?.settlement) return rec;
  if ((rec.status === 'finished' || rec.status === 'killed') && externalSettlementQuiet(rec)) return rec;
  if (rec.settlement.stopRequestId) return rec;
  return updateBoundRun(rec, (next) => {
    next.settlement!.stopRequestId = randomUUID();
    next.settlement!.stopRequestedAt = new Date().toISOString();
    next.status = 'settling';
    next.finishedAt = null;
  });
}

export function bindManagedRunProvider(id: string, digest: string, session: unknown): ManagedRunRecord {
  const rec = findManagedRun(id);
  if (!rec?.settlement || rec.settlement.bindingDigest !== digest) throw new Error('settlement_binding_conflict');
  if (!validProviderSessionId(session)) throw new Error('invalid_provider_session');
  if (rec.settlement.providerSessionId === session) return rec;
  if (rec.settlement.providerSessionId || rec.settlement.receipt?.state === 'quiet') {
    throw new Error('provider_session_conflict');
  }
  return updateBoundRun(rec, (next) => { next.settlement!.providerSessionId = session; });
}

export function recordManagedRunSettlement(id: string, input: Omit<ManagedRunSettlementReceipt, 'receivedAt'>): ManagedRunRecord {
  const rec = findManagedRun(id);
  const s = rec?.settlement;
  if (!rec || !s || s.bindingDigest !== input.bindingDigest || s.binding.receiptId !== input.receiptId
    || s.providerSessionId !== input.providerSessionId || (input.state === 'active' && !s.providerSessionId)
    || (input.state === 'quiet' && !s.providerSessionId && !input.cancelledBeforeLaunch)
    || (input.cancelledBeforeLaunch && s.providerSessionId)
    || (input.state === 'quiet' && s.stopRequestId !== input.stopRequestId)) {
    throw new Error('settlement_binding_conflict');
  }
  const previous = s.receipt;
  if (previous) {
    const { receivedAt: _receivedAt, ...oldInput } = previous;
    if (JSON.stringify(oldInput) === JSON.stringify(input)) return rec;
    if (input.sequence <= previous.sequence || (previous.state === 'quiet' && input.state !== 'quiet')) {
      throw new Error('settlement_receipt_conflict');
    }
  }
  return updateBoundRun(rec, (next) => { next.settlement!.receipt = { ...input, receivedAt: new Date().toISOString() }; });
}

export function retainManagedRunTermination(id: string, termination: ManagedRunTerminationReceipt): void {
  const rec = findManagedRun(id);
  if (rec?.settlement) updateBoundRun(rec, (next) => { next.termination = termination; });
}

/**
 * Reconcile every record against live tmux sessions (one `tmux ls`), settle
 * vanished sessions, prune, persist if anything changed, and return newest-first.
 */
export async function listManagedRuns(): Promise<ManagedRunRecord[]> {
  let alive: Set<string>;
  try {
    alive = new Set((await listCortexTmuxSessions()).filter((n) => n.startsWith('cortex-run-')));
  } catch {
    return [...runs.values()].sort(byStartedDesc);
  }
  const now = new Date().toISOString();
  let changed = false;
  const reconciled: ManagedRunRecord[] = [];
  for (const rec of runs.values()) {
    if (rec.settlement && (rec.status === 'running' || rec.status === 'settling') && !alive.has(rec.session)) {
      const code = rec.exitCode ?? readExitCode(rec);
      const quiet = await inspectOwnedManagedRun(rec);
      const next = finishManagedRun(rec.session, code, quiet);
      if (next?.status === 'finished') reconciled.push(next);
      if (next?.settlement?.stopRequestId && rec.termination && quiet && externalSettlementQuiet(next)) {
        const killed = killManagedRun(rec.session, rec.termination.exitCode, {
          ...rec.termination, confirmedDead: true, confirmedAt: now, externalSettlement: 'quiet',
        });
        if (killed) reconciled.push(killed);
      }
      continue;
    }
    if (rec.status === 'running' && !alive.has(rec.session)) {
      // Only detached runs need exit-file recovery here — streaming runs POST
      // their own finish, and reading the file under them would race the CLI's
      // own read+delete. A detach run's exit-file (when present) gives the real
      // code → finished; absent (killed mid-command / app was down) → gone.
      const code = rec.mode === 'detach' ? readExitCode(rec) : null;
      if (rec.mode === 'detach' && code === null) retainUnknownExitReceipt(rec);
      rec.status = code === null ? 'gone' : 'finished';
      rec.exitCode = code;
      rec.finishedAt = rec.finishedAt ?? now;
      changed = true;
      reconciled.push(rec);
    }
  }
  if (prune()) changed = true;
  if (changed) persist();
  if (reconciled.length > 0) {
    try {
      const { recordAutomationSourceEvent } = await import('@/lib/automations/source-events');
      for (const rec of reconciled) {
        const eventType = rec.status === 'killed' ? 'killed' : rec.status === 'gone' ? 'lost'
          : rec.exitCode === 0 ? 'exit_clean' : 'exit_failed';
        recordAutomationSourceEvent({
          sourceKind: 'managed_run',
          sourceId: rec.id,
          repoPath: rec.cwd,
          eventType,
          fingerprint: rec.status === 'killed' ? `managed-run:${rec.id}:killed:${rec.finishedAt ?? 'unknown'}` : rec.status === 'gone'
            ? `managed-run:${rec.id}:lost:${rec.finishedAt ?? 'unknown'}`
            : `managed-run:${rec.id}:finished:${rec.exitCode ?? 'unknown'}`,
          occurredAt: Date.parse(rec.finishedAt ?? now) || Date.now(),
          payload: { exitCode: rec.exitCode ?? null, status: rec.status, mode: rec.mode },
        });
      }
    } catch {
      // Run reconciliation stays available if automation storage is unavailable.
    }
  }
  return [...runs.values()].sort(byStartedDesc);
}

/** All still-running runs, newest-first (used by the ports route for pane-pid attribution). */
export function listRunningRuns(): ManagedRunRecord[] {
  return [...runs.values()].filter((r) => r.status === 'running' || r.status === 'settling').sort(byStartedDesc);
}

/** Drop oldest terminal records beyond RETENTION. Returns true if anything was removed. */
function prune(): boolean {
  if (runs.size <= RETENTION) return false;
  const terminal = [...runs.values()].filter((r) => r.status !== 'running' && r.status !== 'settling' && !r.settlement);
  terminal.sort((a, b) => (a.finishedAt ?? a.startedAt ?? '').localeCompare(b.finishedAt ?? b.startedAt ?? ''));
  let excess = runs.size - RETENTION;
  let removed = false;
  for (const rec of terminal) {
    if (excess <= 0) break;
    runs.delete(rec.session);
    excess -= 1;
    removed = true;
  }
  return removed;
}
