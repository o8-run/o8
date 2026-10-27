import { assertWorkerMemoryCurrent } from '@/lib/dispatch/worker-memory-context';
import { reserveWorkLaunch, WorkAdmissionExpiredError } from '@/lib/app-update/work-launch-admission';
/**
 * Bundled Pi as a packet worker (#3258): the Pi SDK session from
 * `src/lib/pi/sdk/session.ts` behind the owned-session contract, on the managed
 * model route (paid plan token or the free allowance; the worker process never
 * holds a credential).
 *
 * Each turn starts one Pi process in the launch workspace and closes it when the
 * turn settles, which is the completion signal. The next turn starts a new
 * process on the same Pi session file. Pi's state lives in the o8-owned session
 * directory, outside the workspace.
 *
 * A launch bound to a packet lane runs under lane rules (`lane-approval.ts`):
 * no per-call inbox approval inside the lane worktree, command policy still
 * applied. Any other launch keeps per-call inbox approval.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { createPiLaneApproval, createPiLaneAuthority } from '@/lib/pi/sdk/lane-approval';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import { isOpenRouterPiModelChoice } from '@/lib/pi/sdk/openrouter-model-choice';
import type { createPiSdkSession } from '@/lib/pi/sdk/session';
import { newestPiSessionFile } from '@/lib/pi/sdk/session-files';
import { escalateInterrupt } from '@/lib/runtime/interrupt-escalation';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
  readOwnedSessionState,
} from '@/lib/runtimes/shared/owned-session/archive';
import {
  compactText,
  ensureDir,
  isPidAlive,
  metadataPath,
  nowIso,
  pidCommandLine,
  readJsonFile,
  resolveRepoContext,
  validateWorkspace,
  writeJsonFile,
} from '@/lib/runtimes/shared/owned-session/helpers';
import type {
  OwnedLaunchRequest,
  OwnedRunOutcome,
  OwnedSessionRecord,
  OwnedSessionStore,
} from '@/lib/runtimes/shared/owned-session/types';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { piWorkerFleet, piWorkerReviewPacket, piWorkerTail, reviewDispositionNote } from './presentation';
import { piWorkerLogLines } from './run-log';
import { getOwnedPiBuiltinTelemetrySources } from './telemetry';
import {
  PI_BUILTIN_RUNTIME_ID,
  PI_BUILTIN_SURFACE_PREFIX,
  type PiWorkerLogLine,
  type PiWorkerRunRecord,
  type PiWorkerSessionRecord,
} from './types';

/** Per-turn limits for a packet turn, the same size as an orchestrator turn. */
export const PI_WORKER_LIMITS = { maxModelCalls: 40, maxToolCalls: 80, runTimeoutMs: 30 * 60_000 } as const;
/** Pi startup (SDK import, model route, worker process) settles as failed past this (#3741). */
export const PI_WORKER_START_TIMEOUT_MS = 120_000;
const startTimeoutMs = () => Number(process.env.O8_PI_WORKER_START_TIMEOUT_MS) || PI_WORKER_START_TIMEOUT_MS;

const RUNS_DIR = 'runs';
/** Matches the worker script in a source checkout and in the packaged app. */
const PROCESS_LABEL = 'pi-sdk/worker.mjs';
const SYSTEM_PROMPT = 'You are an o8 packet worker in this workspace. Use only the declared tools: read_file, '
  + 'write_file, and run_command, which runs a shell command at the workspace root. In a packet lane, '
  + 'commands have no network access and can write only inside the workspace, never its .git. Do not '
  + 'commit: o8 commits your work when it goes to review. Follow the task\'s other instructions. Do not '
  + 'claim success after a denied or failed action.';

type PiSession = Awaited<ReturnType<typeof createPiSdkSession>>;

/** A turn this host owns from before its Pi process starts until the turn has settled. */
interface LiveTurn {
  runId: string;
  /** Unset while the Pi process is still starting. */
  session?: PiSession;
  log: Promise<void>;
  /** Set by Stop, synchronously, so a turn that has not sent its prompt never sends it. */
  stopped: boolean;
  done: Promise<void>;
}

const root = () => process.env.O8_OWNED_PI_BUILTIN_ROOT || path.join(getDataDir(), 'owned-pi-builtin');
const live = new Map<string, LiveTurn>();
const chains = new Map<string, Promise<unknown>>();
const withSession = <T>(surfaceId: string, fn: () => Promise<T>) => chainOnKey(chains, surfaceId, fn);

async function listDirs(base = root()): Promise<string[]> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
}

async function loadSession(sessionDir: string): Promise<PiWorkerSessionRecord | null> {
  return readJsonFile<PiWorkerSessionRecord>(metadataPath(sessionDir)).catch(() => null);
}

async function findSession(surfaceId: string, includeArchive = true): Promise<PiWorkerSessionRecord | null> {
  for (const sessionDir of await listDirs()) {
    const session = await loadSession(sessionDir);
    if (session?.surfaceId === surfaceId) return session;
  }
  if (!includeArchive) return null;
  const archivedPath = await archivedSessionPathForSurfaceId(root(), surfaceId, PI_BUILTIN_SURFACE_PREFIX);
  const archived = archivedPath ? await loadSession(archivedPath) : null;
  if (!archivedPath || archived?.surfaceId !== surfaceId) return null;
  const rebase = (run: PiWorkerRunRecord) => ({
    ...run, stdoutPath: path.join(archivedPath, RUNS_DIR, path.basename(run.stdoutPath)),
  });
  return { ...archived, sessionDir: archivedPath, recentRuns: archived.recentRuns.map(rebase) };
}

async function saveSession(session: PiWorkerSessionRecord): Promise<void> {
  session.updatedAt = nowIso();
  await writeJsonFile(metadataPath(session.sessionDir), session, { mode: 0o600 });
}

function replaceRun(session: PiWorkerSessionRecord, run: PiWorkerRunRecord) {
  session.recentRuns = session.recentRuns.map((candidate) => (candidate.id === run.id ? run : candidate));
  if (session.activeRun?.id === run.id) session.activeRun = run;
}

/** A running turn this host does not hold and whose process is gone ended unsettled. */
async function refreshSession(session: PiWorkerSessionRecord): Promise<void> {
  const run = session.activeRun;
  if (!run || live.has(session.surfaceId) || (run.pid && isPidAlive(run.pid))) return;
  await withSession(session.surfaceId, async () => {
    const current = await findSession(session.surfaceId, false);
    const active = current?.activeRun;
    if (!current || !active || live.has(current.surfaceId) || (active.pid && isPidAlive(active.pid))) return;
    if (active.outcome === 'running') {
      active.outcome = 'failed';
      active.finishedAt = active.finishedAt ?? nowIso();
      replaceRun(current, active);
      current.latestSummary = 'The Pi process ended before the turn settled.';
    }
    current.activeRun = undefined;
    await saveSession(current);
    Object.assign(session, current);
  });
}

async function listSessions(): Promise<PiWorkerSessionRecord[]> {
  const sessions = (await Promise.all((await listDirs()).map(loadSession)))
    .filter((session): session is PiWorkerSessionRecord => Boolean(session && !session.detachedAt));
  await Promise.all(sessions.map(refreshSession));
  return sessions;
}

/** The lane receipts every owned worker leaves when its process ends, and the supervisor push on a clean finish. */
async function recordCompletion(session: PiWorkerSessionRecord, run: PiWorkerRunRecord) {
  if (!session.laneId) return;
  const clean = run.outcome === 'finished';
  try {
    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(session.laneId, 'runtime_process_exit', 'system', {
      runtime: PI_BUILTIN_RUNTIME_ID,
      surfaceId: session.surfaceId,
      runId: run.id,
      // The Pi process is closed when its turn settles; the turn outcome classifies the exit.
      exitCode: clean ? 0 : null,
      signal: null,
      classification: clean ? 'clean-exit' : 'nonzero-exit',
      runtimeOutcome: run.outcome,
      stderr: '',
      completedTurn: clean,
    });
  } catch (error) {
    console.warn(`[pi-builtin] Failed to record runtime_process_exit for lane ${session.laneId}:`, error);
  }
  if (!clean) return;
  try {
    const [{ resolvePortInfo }, { getOrCreateWsToken }] = await Promise.all([
      import('@/lib/panel/api-port'),
      import('@/lib/ws-auth'),
    ]);
    await fetch(`http://127.0.0.1:${resolvePortInfo().wsPort}/supervisor/completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ surfaceId: session.surfaceId, runId: run.id }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    console.warn(`[pi-builtin] completion push failed for ${session.surfaceId} (salvage nets remain):`, error);
  }
}

async function settle(surfaceId: string, runId: string, outcome: OwnedRunOutcome, summary: string) {
  const settled = await withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    const run = session?.recentRuns.find((candidate) => candidate.id === runId);
    if (!session || !run || run.outcome !== 'running') return null;
    run.outcome = run.interruptRequestedAt && outcome !== 'finished' ? 'interrupted' : outcome;
    run.finishedAt = nowIso();
    run.finishReason = run.outcome;
    await appendFile(run.stdoutPath, `${JSON.stringify({ at: run.finishedAt, type: 'settled', outcome: run.outcome,
      summary } satisfies PiWorkerLogLine & { at: string })}\n`, 'utf8');
    replaceRun(session, run);
    if (session.activeRun?.id === runId) session.activeRun = undefined;
    session.latestSummary = compactText(summary, 2_000);
    await saveSession(session);
    return { session, run };
  });
  if (settled) await recordCompletion(settled.session, settled.run);
}

async function createRun(surfaceId: string, prompt: string, mode: 'launch' | 'resume') {
  return withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error('Pi session was not found.');
    assertWorkerMemoryCurrent(session);
    if (session.detachedAt) throw new Error('Pi session was detached from its closed packet and cannot be resumed.');
    if (session.activeRun?.outcome === 'running') throw new Error('Pi is still working on the previous turn.');
    await ensureDir(path.join(session.sessionDir, RUNS_DIR));
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const run: PiWorkerRunRecord = {
      id, mode, prompt, startedAt: nowIso(), outcome: 'running',
      stdoutPath: path.join(session.sessionDir, RUNS_DIR, `${id}.jsonl`),
    };
    await appendFile(run.stdoutPath, '', 'utf8');
    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140);
    session.reviewDisposition = 'watching';
    session.reviewDispositionUpdatedAt = nowIso();
    session.activeRun = run;
    session.recentRuns = [run, ...session.recentRuns].slice(0, 32);
    await saveSession(session);
    return { session, run };
  });
}

/**
 * Runs the prompt on its own Pi process, unless the turn was stopped or replaced
 * while the process started; resolves once the process is closed and the turn
 * has settled.
 */
async function runTurn(turn: LiveTurn, surfaceId: string, run: PiWorkerRunRecord, prompt: string) {
  let outcome: OwnedRunOutcome = 'failed';
  let summary = 'Pi run failed.';
  try {
    const memory = await findSession(surfaceId, false);
    if (!memory) throw new Error('Pi session disappeared.');
    assertWorkerMemoryCurrent(memory);
    const current = memory.activeRun?.id === run.id && memory.activeRun.outcome === 'running' && !memory.activeRun.interruptRequestedAt;
    // No await between this check and prompt(), which marks the session busy before
    // its first await, so a later Stop always finds a run to abort.
    const result: { text?: string; errorMessage?: string } = turn.stopped || !current
      ? { errorMessage: 'Stopped' }
      : await turn.session!.prompt(prompt);
    if (result.errorMessage === 'Stopped') {
      outcome = 'interrupted';
      summary = 'Pi was stopped.';
    } else if (result.errorMessage) {
      summary = result.errorMessage;
    } else {
      outcome = 'finished';
      summary = result.text?.trim() || 'Pi finished the turn.';
    }
  } catch {
    summary = 'Pi stopped unexpectedly.';
  } finally {
    await turn.session?.close().catch(() => {});
    await turn.log;
    if (live.get(surfaceId) === turn) live.delete(surfaceId);
  }
  await settle(surfaceId, run.id, outcome, summary);
}

class PiStartTimeoutError extends Error {
  constructor(ms: number) {
    super(`Pi did not start within ${Math.round(ms / 1000)} seconds, so the turn was not run.`);
  }
}

async function dispatchPrompt(surfaceId: string, prompt: string, mode: 'launch' | 'resume') {
  const admission = reserveWorkLaunch(`Agent session ${surfaceId}`);
  try { admission.started(process.pid); } catch (error) { admission.release(); throw error; }
  const { session, run } = await createRun(surfaceId, prompt, mode).catch(error => { admission.release(); throw error; });
  let finished!: () => void;
  const turn: LiveTurn = { runId: run.id, log: Promise.resolve(), stopped: false,
    done: new Promise<void>((resolve) => { finished = resolve; }) };
  // Owned before the process starts, so Stop and discovery see this turn throughout startup.
  live.set(surfaceId, turn);
  const write = (line: PiWorkerLogLine) => {
    turn.log = turn.log.then(() => appendFile(run.stdoutPath, `${JSON.stringify({ at: nowIso(), ...line })}\n`, 'utf8'))
      .catch(() => {});
  };
  const start = async () => {
    // Loaded on the first Pi turn, so runtime registration never evaluates the Pi SDK.
    const { createPiSdkSession } = await import('@/lib/pi/sdk/session');
    const stateDir = path.join(session.sessionDir, 'pi');
    let model = O8_MANAGED_PI_MODEL;
    const attribution = { role: 'worker' as const, agentName: 'pi-builtin', sessionKey: surfaceId, repoPath: session.repoPath,
      laneId: session.laneId ?? null, packetId: session.packetId ?? null, runId: run.id };
    let transport: Parameters<typeof createPiSdkSession>[0]['transport'];
    if (isOpenRouterPiModelChoice(session.model)) {
      // An explicit OpenRouter pin runs only on that model, bounded by the operator's packet cap.
      const choice = await import('@/lib/pi/openrouter-choice');
      const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
      const route = await choice.resolvePiModelRoute(session.model);
      if (route.carrier === 'openrouter') {
        model = route.model;
        transport = choice.createPiOpenRouterRouteTransport(route, {
          ceilingUsd: getOperatorDefaultsSync().values.meteredPacketCostCapUsd,
          attribution,
        }).transport;
      }
    } else {
      // Managed calls are metered by the relay; each is also recorded locally with its tokens (#3742).
      const { createPiManagedUsageTransport } = await import('@/lib/pi/managed-usage');
      transport = createPiManagedUsageTransport(model, attribution);
    }
    return createPiSdkSession({
      workspace: session.cwd,
      stateDir,
      model,
      transport,
      sessionFile: await newestPiSessionFile(path.join(stateDir, 'sessions')),
      approve: session.laneId ? createPiLaneApproval(session.cwd, session.laneId) : undefined,
      authorize: session.laneId ? createPiLaneAuthority(session.cwd, session.laneId) : undefined,
      confineCommands: Boolean(session.laneId),
      systemPrompt: SYSTEM_PROMPT,
      readOnly: session.readOnly,
      onEvent: (event) => { for (const line of piWorkerLogLines(event)) write(line); },
      ...PI_WORKER_LIMITS,
    });
  };
  const starting = start();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    turn.session = await Promise.race([starting, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new PiStartTimeoutError(startTimeoutMs())), startTimeoutMs());
    })]);
    try { admission.started(turn.session.pid ?? process.pid); } catch (error) {
      if (error instanceof WorkAdmissionExpiredError) {
        await turn.session.close();
        throw error;
      }
      // Retain startup ownership through close on a PID write I/O fault.
    }
  } catch (error) {
    // A start that completes after the deadline is closed, never left running unowned.
    if (error instanceof PiStartTimeoutError) {
      void starting.then((late) => late.close()).finally(admission.release).catch(() => {});
    } else admission.release();
    const detail = error instanceof Error ? error.message : String(error);
    const known = /^The Pi prototype (?:needs Node|does not support)/.test(detail)
      || (error instanceof Error && (error.name === 'PiModelChoiceError' || error instanceof PiStartTimeoutError));
    if (!known) console.warn('[pi-builtin] Pi could not start:', error);
    const note = known ? detail : 'Pi could not start. Details are in the o8 log.';
    if (live.get(surfaceId) === turn) live.delete(surfaceId);
    await settle(surfaceId, run.id, 'failed', note);
    finished();
    return { ok: false, note, sideEffect: 'none' as const };
  } finally {
    clearTimeout(deadline);
  }
  const started = turn.session;
  void (async () => {
    await withSession(surfaceId, async () => {
      const current = await findSession(surfaceId, false);
      if (!current?.activeRun || current.activeRun.id !== run.id) return;
      current.threadId = started.sessionId;
      current.activeRun.pid = started.pid;
      current.activeRun.commandIdentity = path.basename(process.execPath);
      replaceRun(current, current.activeRun);
      await saveSession(current);
    });
    await runTurn(turn, surfaceId, run, prompt);
  })().catch((error) => {
    console.error('[pi-builtin] turn settlement failed', error);
  }).finally(() => { admission.release(); finished(); });
  return {
    ok: true,
    note: mode === 'launch' ? 'Pi (built-in) started the first turn.' : 'Pi (built-in) started the follow-up turn.',
  };
}

async function launch(request: OwnedLaunchRequest & { workMode?: WorkerWorkMode }) {
  const prompt = request.prompt.trim();
  const refused = (note: string) => ({ ok: false, runtime: PI_BUILTIN_RUNTIME_ID, surfaceId: '', note,
    sideEffect: 'none' as const });
  if (!prompt) return refused('prompt is required');
  let cwd: string;
  let repoPath: string;
  try {
    repoPath = await validateWorkspace(request.cwd);
    cwd = await realpath(request.cwd);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  const repo = await resolveRepoContext(repoPath);
  const id = `${PI_BUILTIN_RUNTIME_ID}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(root(), id);
  await mkdir(sessionDir, { recursive: true });
  const session: PiWorkerSessionRecord = {
    surfaceId: `${PI_BUILTIN_SURFACE_PREFIX}${id}`,
    launchMutationId: request.clientMutationId?.trim() || undefined,
    laneId: request.laneId?.trim() || undefined,
    packetId: request.packetId?.trim() || undefined,
    sessionDir,
    cwd,
    repoPath,
    repoSlug: repo.repoSlug,
    branch: repo.branch,
    head: repo.head,
    title: repo.title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    latestPrompt: prompt,
    promptMemoryRevision: request.promptMemoryRevision,
    latestSummary: compactText(prompt, 140),
    // The managed model unless the packet pins an OpenRouter model (#3584); any other request keeps the managed route.
    model: isOpenRouterPiModelChoice(request.model) ? request.model : O8_MANAGED_PI_MODEL.id,
    readOnly: request.workMode === 'read-only',
    reviewDisposition: 'watching',
    reviewDispositionUpdatedAt: nowIso(),
    recentRuns: [],
  };
  await saveSession(session);
  const result = await dispatchPrompt(session.surfaceId, prompt, 'launch');
  return { ...result, runtime: PI_BUILTIN_RUNTIME_ID, surfaceId: session.surfaceId };
}

async function resume(surfaceId: string, message: string) {
  const prompt = message.trim();
  if (!prompt) return { ok: false, note: 'message is required', sideEffect: 'none' as const };
  try {
    return await dispatchPrompt(surfaceId, prompt, 'resume');
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error), sideEffect: 'none' as const };
  }
}

async function interrupt(surfaceId: string) {
  const session = await findSession(surfaceId, false);
  if (!session) throw new Error('Pi session was not found.');
  const turn = live.get(surfaceId);
  const run = session.activeRun;
  if (turn) {
    turn.stopped = true;
    await withSession(surfaceId, async () => {
      const current = await findSession(surfaceId, false);
      if (current?.activeRun?.id !== turn.runId) return;
      current.activeRun.interruptRequestedAt = nowIso();
      replaceRun(current, current.activeRun);
      await saveSession(current);
    });
    // A turn still starting has no process to abort; it sees `stopped` and never prompts.
    await turn.session?.abort().catch(() => {});
    await turn.done;
    return { interrupted: true, note: 'Pi stopped. The next message resumes the same session.' };
  }
  if (run?.pid && isPidAlive(run.pid)) {
    // A process this host does not hold: signal it only when it is still the Pi worker.
    if (!(await pidCommandLine(run.pid))?.includes(PROCESS_LABEL)) {
      return { interrupted: false, note: `Stored pid ${run.pid} is no longer the Pi worker; it was not signaled.` };
    }
    const stopped = await escalateInterrupt({ pid: run.pid, commandLabel: PROCESS_LABEL });
    if (!stopped.confirmedDead && !stopped.alreadyDead) return { interrupted: false, note: stopped.note };
  }
  if (run) {
    await withSession(surfaceId, async () => {
      const current = await findSession(surfaceId, false);
      const active = current?.activeRun;
      if (!current || !active) return;
      if (active.outcome === 'running') {
        active.outcome = 'interrupted';
        active.finishedAt = nowIso();
        active.interruptRequestedAt = active.finishedAt;
        replaceRun(current, active);
      }
      current.activeRun = undefined;
      await saveSession(current);
    });
  }
  return { interrupted: true, note: 'Pi is stopped. The next message resumes the same session.' };
}

async function archiveSession(surfaceId: string) {
  const session = await findSession(surfaceId, false);
  if (!session) {
    const archived = await archivedSessionPathForSurfaceId(root(), surfaceId, PI_BUILTIN_SURFACE_PREFIX);
    return archived
      ? { archived: true, archivePath: archived, note: 'Session already archived.' }
      : { archived: false, note: 'Pi session was not found.' };
  }
  const stopped = await interrupt(surfaceId);
  if (!stopped.interrupted) return { archived: false, note: stopped.note };
  const latest = await findSession(surfaceId, false);
  if (!latest) return { archived: false, note: 'Session disappeared before archive.' };
  return archiveOwnedSessionDir(root(), latest as unknown as OwnedSessionRecord);
}

function setDetachedSession(surfaceId: string, reason: string | null) {
  return withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    if (!session) return { updated: false, previouslyDetached: false, note: 'Pi session was not found.' };
    const previouslyDetached = Boolean(session.detachedAt);
    if (reason === null) {
      delete session.detachedAt;
      delete session.detachedReason;
    } else {
      session.detachedAt = session.detachedAt ?? nowIso();
      session.detachedReason = reason;
    }
    await saveSession(session);
    return {
      updated: true,
      previouslyDetached,
      note: reason === null
        ? 'Pi session was restored to active discovery.'
        : 'Pi recovery metadata was preserved outside active fleet discovery.',
    };
  });
}

const store: OwnedSessionStore = {
  runtimeId: PI_BUILTIN_RUNTIME_ID,
  surfaceIdPrefix: PI_BUILTIN_SURFACE_PREFIX,
  launch,
  resume,
  interrupt,
  async getRuntimeTail(surfaceId, limit) {
    const session = await findSession(surfaceId, true);
    if (!session) throw new Error('Pi session was not found.');
    return piWorkerTail(session, limit);
  },
  async getReviewPacket(surfaceId) {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error('Pi review packet was not found.');
    return piWorkerReviewPacket(session);
  },
  async getFleetAdditions() {
    return piWorkerFleet(await listSessions());
  },
  sessionState: (surfaceId) => readOwnedSessionState(root(), surfaceId, PI_BUILTIN_SURFACE_PREFIX),
  archiveSession,
  setDetachedSession,
  async sweepOrphanedSessions(activeSurfaceIds, maxAgeMs) {
    let archived = 0;
    for (const session of await listSessions()) {
      if (activeSurfaceIds.has(session.surfaceId)) continue;
      if (Date.now() - Date.parse(session.updatedAt) < maxAgeMs) continue;
      if ((await archiveSession(session.surfaceId).catch(() => null))?.archived) archived += 1;
    }
    return archived;
  },
  getTelemetrySources: getOwnedPiBuiltinTelemetrySources,
  getSessionIdentityId: async () => null,
  async setReviewDisposition(surfaceId, disposition) {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error('Pi session was not found.');
    session.reviewDisposition = disposition;
    session.reviewDispositionUpdatedAt = nowIso();
    await saveSession(session);
    return { disposition, note: reviewDispositionNote(disposition) };
  },
  invalidateFleetCache: () => {},
};

registerOwnedSessionLifecycleHandler({
  runtimeId: PI_BUILTIN_RUNTIME_ID,
  surfaceIdPrefix: PI_BUILTIN_SURFACE_PREFIX,
  commandLabel: PROCESS_LABEL,
  resolveRoot: root,
  sessionState: store.sessionState,
  archiveSession: store.archiveSession,
  setDetachedSession: store.setDetachedSession,
});

export const launchOwnedPiBuiltinSession = launch;
export const resumeOwnedPiBuiltinSession = store.resume.bind(store);
export const interruptOwnedPiBuiltinSession = store.interrupt.bind(store);
export const getOwnedPiBuiltinFleetAdditions = store.getFleetAdditions.bind(store);
export const getOwnedPiBuiltinRuntimeTail = store.getRuntimeTail.bind(store);
export const getOwnedPiBuiltinReviewPacket = store.getReviewPacket.bind(store);
export { getOwnedPiBuiltinTelemetrySources } from './telemetry';
export const archiveOwnedPiBuiltinSession = store.archiveSession.bind(store);
