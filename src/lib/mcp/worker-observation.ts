import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';
import { isOrchestratorRuntime, runtimeFromOwnedSessionKey } from '@/lib/orchestrator/runtime-capabilities';
import { currentRecoveryRun, recoveryInterrupted } from '@/lib/runtimes/shared/owned-session/automatic-recovery';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { readTranscriptTextPage } from './transcript-text-pages';
import { McpInputError, safeErrorText } from './api-error';

type RecordValue = Record<string, unknown>;
type ApiFetch = (path: string, options?: RequestInit) => Promise<unknown>;
interface ObservationConfig { repoPath: string; parentThreadId: string }
interface Membership {
  surfaceId: string; runtime: string; checkoutMode: 'shared' | 'isolated';
  membership: 'active' | 'archived'; packetId?: string;
}

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
function readJson(path: string): RecordValue {
  try { return record(JSON.parse(readFileSync(path, 'utf8'))); } catch { return {}; }
}
function canonical(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  try { return realpathSync(path); } catch { return null; }
}

/** Open existing receipts read-only. Observation never initializes or migrates the DB. */
function withReceipts<T>(read: (db: Database.Database) => T, fallback: T): T {
  let db: Database.Database | undefined;
  try {
    db = new Database(process.env.CORTEX_IDE_DB_PATH || join(getDataDir(), 'cortex-ide.db'), { readonly: true, fileMustExist: true });
    return read(db);
  } catch { return fallback; } finally { db?.close(); }
}
function query(db: Database.Database, sql: string, ...args: string[]): RecordValue[] {
  try { return db.prepare(sql).all(...args) as RecordValue[]; } catch { return []; }
}

/** Membership proves association only; it never enables a runtime action. */
export function relatedWorkerMembership(config: ObservationConfig): Membership[] {
  const repo = canonical(config.repoPath);
  if (!repo || !config.parentThreadId) return [];
  const members = new Map<string, Membership>();
  const add = (surfaceId: unknown, runtime: unknown, extra: Omit<Membership, 'surfaceId' | 'runtime'>) => {
    if (typeof surfaceId !== 'string' || !isOrchestratorRuntime(runtime) || runtimeFromOwnedSessionKey(surfaceId) !== runtime) return;
    const prior = members.get(surfaceId);
    // A live Shared membership keeps its checkout-owner fence even if an
    // packet also names this surface. Active ownership beats archives.
    if (!prior || (extra.membership === 'active'
      && (prior.membership === 'archived' || prior.checkoutMode !== 'shared'))) {
      members.set(surfaceId, { surfaceId, runtime, ...extra });
    }
  };
  const directory = join(getDataDir(), 'shared-checkout-teams');
  const id = createHash('sha256').update(repo).digest('hex').slice(0, 24);
  let archived: string[] = [];
  try { archived = readdirSync(join(directory, 'archive')).filter(name => name.startsWith(`${id}-`) && name.endsWith('.json')).sort(); } catch { /* No archived teams. */ }
  for (const [path, membership] of [
    ...archived.map(name => [join(directory, 'archive', name), 'archived'] as const),
    [join(directory, `${id}.json`), 'active'] as const,
  ]) {
    const team = readJson(path);
    if (canonical(team.path) !== repo || team.parentThreadId !== config.parentThreadId) continue;
    for (const member of rows(team.members)) add(member.surfaceId, member.runtime, { checkoutMode: 'shared', membership });
  }
  const current = record(readJson(join(getDataDir(), 'orchestrator-state.json')).mission);
  const stored = withReceipts(db => {
    const missions = query(db, 'SELECT mission_state_json FROM missions WHERE repo_path = ?', repo);
    const packets = missions.flatMap(mission => {
      try { return rows(record(JSON.parse(String(mission.mission_state_json))).packets); } catch { return []; }
    });
    return { packets, lanes: query(db, 'SELECT session_key, runtime, repo_path, packet_id FROM lanes WHERE repo_path = ?', repo) };
  }, { packets: [] as RecordValue[], lanes: [] as RecordValue[] });
  for (const packet of [...rows(current.packets), ...stored.packets]) {
    if (packet.orchestratorThreadId !== config.parentThreadId || canonical(packet.workspaceTargetPath) !== repo || typeof packet.id !== 'string') continue;
    for (const lane of stored.lanes.filter(lane => lane.packet_id === packet.id)) {
      if (canonical(lane.repo_path) === repo) add(lane.session_key, lane.runtime, { checkoutMode: 'isolated', membership: 'active', packetId: packet.id });
    }
    const lane = record(packet.lane);
    add(lane.sessionKey, packet.runtime, { checkoutMode: 'isolated', membership: 'active', packetId: packet.id });
  }
  return [...members.values()].sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
}

async function observe(config: ObservationConfig, surfaceIds: string[]) {
  const members = relatedWorkerMembership(config);
  const selected = surfaceIds.map(surfaceId => {
    const member = members.find(item => item.surfaceId === surfaceId);
    if (!member) throw new McpInputError('A requested worker is not recorded for this parent conversation and repository.');
    return member;
  });
  return Promise.all(selected.map(async member => {
    const session = await readOwnedSessionRecord(member.surfaceId);
    const run = session ? currentRecoveryRun(session) : undefined;
    const runId = run?.id ?? null;
    const delivery = runId ? withReceipts(db => query(db, `SELECT r.id, r.run_id, r.status, r.reason FROM shared_worker_returns r
      JOIN shared_worker_parents p ON p.surface_id = r.surface_id
      WHERE p.surface_id = ? AND p.repo_path = ? AND p.thread_id = ? AND r.run_id = ?`,
    member.surfaceId, canonical(config.repoPath)!, config.parentThreadId, runId)[0] ?? null, null) : null;
    return { ...member, runId, outcome: run?.outcome ?? 'unknown',
      startedAt: run?.startedAt ?? null, finishedAt: run?.finishedAt ?? null,
      interrupted: session && runId ? recoveryInterrupted(session) : null,
      delivery: delivery ? { id: delivery.id, runId: delivery.run_id, status: delivery.status, reason: delivery.reason ?? null } : { status: 'unknown' },
    };
  }));
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new McpInputError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export async function waitForRelatedWorkers(config: ObservationConfig, args: RecordValue) {
  if (!canonical(config.repoPath) || !config.parentThreadId) throw new McpInputError('Worker observation requires a persisted parent conversation and workspace.');
  if (!Array.isArray(args.surfaceIds) || args.surfaceIds.length < 1 || args.surfaceIds.length > 8
    || args.surfaceIds.some(id => typeof id !== 'string' || !id || id.length > 240)) throw new McpInputError('surfaceIds must contain one to eight recorded worker IDs.');
  const surfaceIds = [...new Set(args.surfaceIds as string[])].sort();
  const timeoutMs = integer(args.timeoutMs, 10_000, 0, 30_000, 'timeoutMs');
  if (args.afterCursor !== undefined && (typeof args.afterCursor !== 'string' || !/^w1\.[A-Za-z0-9_-]{43}$/.test(args.afterCursor))) throw new McpInputError('afterCursor is not a worker observation cursor.');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const workers = await observe(config, surfaceIds);
    const cursor = `w1.${createHash('sha256').update(JSON.stringify([canonical(config.repoPath), config.parentThreadId, workers])).digest('base64url')}`;
    const changed = cursor !== args.afterCursor;
    if (changed || performance.now() >= deadline) return { workers, cursor, changed, timedOut: !changed, observationOnly: true };
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))));
  }
}

export function createWorkerObservationHandlers(config: ObservationConfig, apiFetch: ApiFetch) {
  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const guarded = (handler: (args: RecordValue) => Promise<unknown>) => async (args: RecordValue) => {
    try { return json(await handler(args)); }
    catch (error) { return { content: [{ type: 'text' as const, text: safeErrorText(error) }], isError: true }; }
  };
  return {
    handleWaitWorkers: guarded(args => waitForRelatedWorkers(config, args)),
    handleFleetStatus: guarded(async args => {
      const data = record(await apiFetch(`/api/runtime/inventory?fresh=${args.fresh === true ? '1' : ''}`, { signal: AbortSignal.timeout(10_000) }));
      const related = relatedWorkerMembership(config);
      const agents = rows(data.agents).filter(agent => isOrchestratorRuntime(agent.runtime));
      return { agentCount: agents.length, truncated: agents.length > 200, agents: agents.slice(0, 200).map(agent => {
        const surface = record(agent.runtimeSurface);
        const surfaceId = typeof surface.id === 'string' ? surface.id : agent.sessionKey;
        return { name: agent.name, runtime: agent.runtime, surfaceId, sessionKey: agent.sessionKey,
          ownership: surface.ownership ?? agent.sessionKind ?? 'unknown', capabilities: surface.capabilities ?? null,
          related: related.some(member => member.surfaceId === surfaceId), status: agent.status, workspace: agent.workspace,
          branch: agent.branch, task: agent.currentTask, lastActive: agent.lastEventAt };
      }), relatedWorkerCount: related.length, relatedWorkers: related.slice(0, 200), relatedWorkersTruncated: related.length > 200,
      observationOnly: true };
    }),
    handleReadTranscript: guarded(args => readTranscriptTextPage(args, apiFetch)),
  };
}
