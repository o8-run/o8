import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { getSqlite } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { acquireMetadataTransactionLease, releaseMetadataTransactionLease, readMetadataTransactionStateSnapshot } from '@/lib/worktree/metadata-transaction-lease';
import { isManagedPacketWorktreeId, resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import {
  assertWorktreeMetadataEntryBudget, readBoundedMaintenanceFile,
  withWorktreeMaintenanceBudget, WORKTREE_MAINTENANCE_POLICY, WorktreeMaintenanceHeldError,
  type WorktreeMaintenanceBudget,
} from '@/lib/worktree/maintenance-budget';
import {
  advanceMaintenanceCandidate, ensureMaintenanceDiscoverySchema, holdMaintenanceRoot,
  MAINTENANCE_PHASES, metadataDiscoveryRevision, nextMaintenanceCandidate, projectMaintenanceMetadata,
  readMaintenanceState, registerMaintenanceRepository, writeMaintenanceState,
  type MaintenanceCandidate, type MaintenancePhase,
} from '@/lib/worktree/maintenance-discovery';
import { cleanupLaneWorktree } from './worktree-cleanup';
import { getLane, updateLane } from './registry';
import type { Lane } from './types';

interface MaintenanceResult {
  startedAt: string;
  finishedAt?: string;
  candidates: number;
  discoveryPages: number;
  readBytes: number;
  removed: number;
  held: number;
  /** Refused candidates skipped because nothing about them changed since the refusal. */
  deferred: number;
  admissionMilliseconds: number;
  elapsedMilliseconds?: number;
  outcomes: Array<{ phase: MaintenancePhase; scope: string; outcome: string }>;
  registryHold?: string | null;
}

let inFlight: Promise<MaintenanceResult> | null = null;
const terminal = (lane: Lane) => lane.status === 'completed' || lane.status === 'archived';

/*
 * A managed retirement whose exact purge diverged from its journal stays
 * refused until its claim changes. Each pass retried three such claims:
 * a decode of each claim's purge manifest (up to 42 MB of JSON on real data)
 * and a purge capture child, every five minutes. The startup replay already
 * waits on the same refusal; this pass now does too: a day, doubling per
 * refusal of the same claim row, at most a week. A changed claim retries at once.
 */
const REFUSAL_RETRY_MS = 24 * 60 * 60_000;
const REFUSAL_RETRY_MAX_MS = 7 * REFUSAL_RETRY_MS;
const JOURNAL_REFUSED = 'held: exact retirement journal refused';

function refusalStore() {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS worktree_maintenance_refusals (
    phase TEXT NOT NULL, candidate_key TEXT NOT NULL, stamp TEXT NOT NULL,
    refusals INTEGER NOT NULL, retry_after INTEGER NOT NULL,
    PRIMARY KEY (phase, candidate_key)
  )`);
  return sqlite;
}

/** The claim row a retry depends on, read without decoding its purge manifest. */
function claimStamp(candidate: MaintenanceCandidate): string {
  const claim = getSqlite().prepare(`SELECT state, updated_at AS updatedAt FROM workspace_exact_claims
    WHERE kind = 'managed-retirement' AND repository_path = ? AND worktree_id = ?`)
    .get(candidate.repositoryPath, candidate.worktreeId) as { state: string; updatedAt: number } | undefined;
  return claim ? `${claim.state}:${claim.updatedAt}` : '-';
}

function refusalDeferred(phase: MaintenancePhase, candidate: MaintenanceCandidate, now: number): boolean {
  if (phase !== 'claims') return false;
  const row = refusalStore().prepare(`SELECT stamp, retry_after AS retryAfter FROM worktree_maintenance_refusals
    WHERE phase = ? AND candidate_key = ?`).get(phase, candidate.key) as { stamp: string; retryAfter: number } | undefined;
  return Boolean(row && row.stamp === claimStamp(candidate) && row.retryAfter > now);
}

function recordRefusalOutcome(phase: MaintenancePhase, candidate: MaintenanceCandidate, outcome: string, now: number): void {
  if (phase !== 'claims') return;
  const sqlite = refusalStore();
  if (outcome !== JOURNAL_REFUSED) {
    sqlite.prepare('DELETE FROM worktree_maintenance_refusals WHERE phase = ? AND candidate_key = ?').run(phase, candidate.key);
    return;
  }
  // The claim after the refused attempt: only a later change retries early.
  const stamp = claimStamp(candidate);
  const prior = sqlite.prepare(`SELECT stamp, refusals FROM worktree_maintenance_refusals
    WHERE phase = ? AND candidate_key = ?`).get(phase, candidate.key) as { stamp: string; refusals: number } | undefined;
  const refusals = prior?.stamp === stamp ? prior.refusals + 1 : 1;
  const delay = Math.min(REFUSAL_RETRY_MAX_MS, REFUSAL_RETRY_MS * 2 ** Math.min(refusals - 1, 8));
  sqlite.prepare(`INSERT INTO worktree_maintenance_refusals (phase, candidate_key, stamp, refusals, retry_after)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(phase, candidate_key) DO UPDATE SET stamp = excluded.stamp,
      refusals = excluded.refusals, retry_after = excluded.retry_after`)
    .run(phase, candidate.key, stamp, refusals, now + delay);
}

async function seedRegisteredRoots(budget: WorktreeMaintenanceBudget): Promise<string | null> {
  const registryPath = path.join(getDataDir(), 'repos.json');
  const file = await readBoundedMaintenanceFile(registryPath);
  if (!file) return null;
  const { revision } = file;
  const previous = readMaintenanceState<{ revision: string; held: string | null }>('registry');
  if (previous?.revision === revision) return previous.held;
  let held: string | null = null;
  const parsed = JSON.parse(file.text) as { repos?: Array<{ localPath?: unknown }> };
  if (!Array.isArray(parsed.repos) || parsed.repos.length > budget.rootEntries
    || parsed.repos.some((repo) => typeof repo.localPath !== 'string' || !path.isAbsolute(repo.localPath))) {
    held = 'Repository registry is invalid or exceeds the automatic entry policy';
  } else {
    assertWorktreeMetadataEntryBudget(registryPath, parsed.repos.length);
    for (const repo of parsed.repos) registerMaintenanceRepository(repo.localPath as string);
  }
  writeMaintenanceState('registry', { revision, held });
  return held;
}

function candidateLane(candidate: MaintenanceCandidate): Lane | null {
  if (candidate.laneId) return getLane(candidate.laneId);
  const sqlite = getSqlite();
  const byPath = sqlite.prepare('SELECT id FROM lanes WHERE worktree_path = ? LIMIT 2')
    .all(candidate.worktreePath) as Array<{ id: string }>;
  if (byPath.length === 1) return getLane(byPath[0]!.id);
  if (byPath.length > 1) return null;
  const id = candidate.worktreeId ?? '';
  const guesses = candidate.packetId ? [candidate.packetId]
    : id.startsWith('packet-') ? [id.slice(7), id.slice(7, -5)] : [];
  const matches: Lane[] = [];
  for (const packetId of guesses) {
    const rows = sqlite.prepare('SELECT id FROM lanes WHERE packet_id = ? AND repo_path = ? LIMIT 2')
      .all(packetId, candidate.repositoryPath) as Array<{ id: string }>;
    for (const row of rows) {
      const lane = getLane(row.id);
      if (lane && isManagedPacketWorktreeId(id, lane.packetId ?? '')) matches.push(lane);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

async function retireTerminalLane(lane: Lane): Promise<string> {
  registerMaintenanceRepository(lane.repoPath);
  if (!terminal(lane) || !lane.worktreePath) return 'held: no exact terminal workspace association';
  const current = getLane(lane.id);
  if (!current || !terminal(current) || (current.worktreePath && current.worktreePath !== lane.worktreePath)) {
    return 'held: lane association changed';
  }
  // Admit the whole-root authority before preservation or retirement can mutate anything.
  await readWorktreeMetaSnapshot(current.repoPath);
  const removed = await cleanupLaneWorktree({ ...current, worktreePath: lane.worktreePath }, { terminal: true });
  if (removed) {
    const settled = getLane(lane.id);
    if (settled && terminal(settled) && settled.worktreePath === current.worktreePath) {
      updateLane(lane.id, { worktreePath: null }, 'system', { phase: 'bounded_maintenance', worktreeRemoved: true });
    }
  }
  return removed ? 'removed' : 'held: preservation, owner, identity or retention policy refused';
}

async function attemptCandidate(
  phase: MaintenancePhase, candidate: MaintenanceCandidate,
  reconcileActive: (lane: Lane) => Promise<void>,
): Promise<string> {
  if (phase === 'active' || phase === 'terminal' || phase === 'completion') {
    const lane = getLane(candidate.id!);
    if (!lane) {
      if (phase === 'completion') getSqlite().prepare('DELETE FROM worktree_maintenance_pending WHERE lane_id = ?').run(candidate.id);
      return 'absent';
    }
    registerMaintenanceRepository(lane.repoPath);
    if (phase === 'active') {
      if (terminal(lane)) return 'held: lane became terminal';
      await reconcileActive(lane);
      return 'reconciled';
    }
    const outcome = await retireTerminalLane(lane);
    if (phase === 'completion' && (outcome === 'removed' || !terminal(lane) || !lane.worktreePath)) {
      getSqlite().prepare('DELETE FROM worktree_maintenance_pending WHERE lane_id = ?').run(lane.id);
    }
    return outcome;
  }
  if (phase === 'legacy') {
    const root = candidate.metadataRoot!;
    const known = getSqlite().prepare('SELECT repository_path FROM worktree_maintenance_roots WHERE metadata_root = ?')
      .get(root);
    if (!known) {
      getSqlite().prepare(`INSERT OR IGNORE INTO worktree_maintenance_roots
        (metadata_root, repository_path, held_reason, checked_at) VALUES (?, '', ?, ?)`)
        .run(root, 'held: legacy metadata root has no repository association', Date.now());
    }
    return known ? 'discovered' : 'held: legacy root requires verified repository discovery';
  }
  if (phase === 'roots') {
    const repo = candidate.repositoryPath!;
    const root = candidate.metadataRoot!;
    if (!repo) return 'held: metadata root has no repository association';
    const primary = resolveWorktreeRootLayout(repo).primaryBase;
    const canonicalPrimary = await realpath(primary).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return path.resolve(primary);
      throw error;
    });
    if (canonicalPrimary !== root) {
      return 'held: legacy metadata namespace requires an explicit migration';
    }
    const entries = await readWorktreeMetaSnapshot(repo);
    const payload = JSON.stringify({ version: 1, worktrees: entries });
    const sqlite = getSqlite();
    const canonical = await realpath(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return path.resolve(root);
      throw error;
    });
    if (canonical !== root) return 'held: metadata root identity changed';
    sqlite.transaction(() => {
      const durable = readMetadataTransactionStateSnapshot(root, sqlite);
      if (durable && metadataDiscoveryRevision(durable.payload) !== metadataDiscoveryRevision(payload)) {
        throw new WorktreeMaintenanceHeldError(root, 'metadata revision changed during discovery');
      }
      projectMaintenanceMetadata(sqlite, repo, root, payload);
    }).immediate();
    return 'discovered';
  }
  if (phase === 'claims') {
    // Missing public names still have a persisted exact rename/purge journal.
    const removed = await getWorktreeManager(candidate.repositoryPath!).cleanup(candidate.worktreeId!, { force: true });
    return removed ? 'removed' : 'held: exact retirement journal refused';
  }
  const entries = await readWorktreeMetaSnapshot(candidate.repositoryPath!);
  const revision = metadataDiscoveryRevision(JSON.stringify({ version: 1, worktrees: entries }));
  if (revision !== candidate.revision) return 'held: discovery index is stale';
  const entry = entries[candidate.worktreeId!];
  if (!entry || entry.claudeManaged
    || entry.materializationIdentity?.canonicalPath !== candidate.worktreePath) {
    return 'held: exact metadata ownership is unavailable';
  }
  const lane = candidateLane(candidate);
  if (!lane || !terminal(lane) || path.resolve(lane.repoPath) !== path.resolve(candidate.repositoryPath!)) {
    return 'held: terminal owner is unavailable';
  }
  if (lane.worktreePath && path.resolve(lane.worktreePath) !== candidate.worktreePath) {
    return 'held: lane now owns another generation';
  }
  return retireTerminalLane({ ...lane, worktreePath: candidate.worktreePath! });
}

export function runBoundedWorktreeMaintenance(
  reconcileActive: (lane: Lane) => Promise<void>,
  options: { primaryRepoPath?: string; maxCandidates?: number; admissionMilliseconds?: number } = {},
): Promise<MaintenanceResult> {
  if (inFlight) return inFlight;
  const runWithLease = async (): Promise<MaintenanceResult> => {
    ensureMaintenanceDiscoverySchema();
    registerMaintenanceRepository(options.primaryRepoPath ?? process.cwd());
    const start = performance.now();
    const admissionMilliseconds = options.admissionMilliseconds ?? WORKTREE_MAINTENANCE_POLICY.admissionMilliseconds;
    const budget: WorktreeMaintenanceBudget = {
      remainingBytes: WORKTREE_MAINTENANCE_POLICY.metadataBytes, readBytes: 0,
      rootBytes: WORKTREE_MAINTENANCE_POLICY.rootBytes, rootEntries: WORKTREE_MAINTENANCE_POLICY.rootEntries,
    };
    const result: MaintenanceResult = { startedAt: new Date().toISOString(), candidates: 0,
      discoveryPages: 0, readBytes: 0, removed: 0, held: 0, deferred: 0, admissionMilliseconds, outcomes: [] };
    await withWorktreeMaintenanceBudget(budget, async () => {
      try { result.registryHold = await seedRegisteredRoots(budget); }
      catch (error) { result.registryHold = `Registry discovery held: ${error instanceof Error ? error.message : String(error)}`; }
      const maxCandidates = Math.min(WORKTREE_MAINTENANCE_POLICY.candidates,
        Math.max(1, options.maxCandidates ?? WORKTREE_MAINTENANCE_POLICY.candidates));
      let phaseIndex = readMaintenanceState<number>('next-phase') ?? 0;
      let emptyPhases = 0;
      while (result.candidates < maxCandidates && budget.remainingBytes > 0
        && result.discoveryPages < maxCandidates + MAINTENANCE_PHASES.length
        && performance.now() - start < admissionMilliseconds && emptyPhases < MAINTENANCE_PHASES.length) {
        const phase = MAINTENANCE_PHASES[phaseIndex % MAINTENANCE_PHASES.length]!;
        phaseIndex = (phaseIndex + 1) % MAINTENANCE_PHASES.length;
        writeMaintenanceState('next-phase', phaseIndex);
        result.discoveryPages += 1;
        const candidate = nextMaintenanceCandidate(phase);
        if (!candidate) { emptyPhases += 1; continue; }
        emptyPhases = 0;
        if (refusalDeferred(phase, candidate, Date.now())) {
          result.deferred += 1;
          advanceMaintenanceCandidate(phase, candidate.key);
          continue;
        }
        result.candidates += 1;
        let outcome: string;
        try { outcome = await attemptCandidate(phase, candidate, reconcileActive); }
        catch (error) {
          outcome = `held: ${error instanceof Error ? error.message : String(error)}`;
          if (candidate.metadataRoot) holdMaintenanceRoot(candidate.metadataRoot, outcome);
        }
        recordRefusalOutcome(phase, candidate, outcome, Date.now());
        if (outcome.startsWith('held:')) result.held += 1;
        if (phase === 'roots' && outcome.startsWith('held:')) holdMaintenanceRoot(candidate.metadataRoot!, outcome);
        if (outcome === 'removed') result.removed += 1;
        result.outcomes.push({ phase, scope: candidate.worktreePath ?? candidate.metadataRoot ?? candidate.id!, outcome });
        advanceMaintenanceCandidate(phase, candidate.key);
      }
    });
    result.readBytes = budget.readBytes;
    result.finishedAt = new Date().toISOString();
    result.elapsedMilliseconds = performance.now() - start;
    writeMaintenanceState('last-pass', result);
    return result;
  };
  const run = async () => {
    const lease = await acquireMetadataTransactionLease(path.join(getDataDir(), 'worktree-maintenance-lock'));
    try { return await runWithLease(); }
    finally { releaseMetadataTransactionLease(lease); }
  };
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}
