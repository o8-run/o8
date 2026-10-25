import { execFile } from '@/lib/providers/child-process';
import { ownedSupervisorClient } from './o8d-supervisor';
import { attachSupervisedRun } from '@/lib/runtimes/shared/owned-session/supervised-run';
import { promisify } from 'node:util';

import { isBridgeSessionAlive, signalBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { lookupOwnedActiveRunFresh } from '@/lib/runtimes/shared/owned-session-index';
import {
  classifyOwnedRunCommandLine,
  isPidAlive,
  pidCommandLine,
} from '@/lib/runtimes/shared/owned-session/helpers';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { withOwnedStopOutcome } from '@/lib/runtimes/shared/owned-session/stop-outcome';
import { probeOwnedSignalIdentity, type OwnedProcessEvidence } from '@/lib/runtimes/shared/owned-session/process-identity';
import {
  probeOwnedRunMarker,
  probeOwnedRunProcessClaim,
  resolveSpawnedProcessGroupId,
} from '@/lib/runtimes/shared/owned-session/run-process-proof';

export type InterruptEscalationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/**
 * What the ladder ACTUALLY did, as opposed to which rung asked for it.
 *
 * On POSIX the two are the same — the rung's signal is delivered. Windows has
 * exactly one mechanism (`taskkill /PID <pid> /T /F`), so all three rungs do the
 * same forced tree-kill, and recording them as SIGINT/SIGTERM/SIGKILL tells the
 * operator a worker was asked politely when it was actually shot. The audit
 * trail for a stop button has to say which it was.
 */
export type InterruptEscalationMechanism = InterruptEscalationSignal | 'taskkill-tree';

export interface InterruptEscalationTarget extends OwnedProcessEvidence {
  pid?: number;
  processGroupId?: number;
  processMarker?: string;
  tmuxSession?: string;
  commandLabel?: string;
}

export interface InterruptEscalationStep {
  /** The rung of the ladder — what was requested. */
  signal: InterruptEscalationSignal;
  /** What was actually used. Differs from `signal` on Windows. */
  mechanism: InterruptEscalationMechanism;
  sent: boolean;
  /** True only when the complete worker process tree was verified gone. */
  confirmedDead: boolean;
  /** Fail-closed: false is only possible when `confirmedDead` is true. */
  aliveAfter: boolean;
  error?: string;
  verificationNote?: string;
  unconfirmedPids?: number[];
}

export interface InterruptEscalationResult {
  attempted: boolean;
  confirmedDead: boolean;
  alreadyDead: boolean;
  steps: InterruptEscalationStep[];
  pid?: number;
  tmuxSession?: string;
  note: string;
}

export interface InterruptEscalationDeps {
  isAlive(target: InterruptEscalationTarget): Promise<boolean | InterruptLivenessProbe> | boolean | InterruptLivenessProbe;
  kill(target: InterruptEscalationTarget, signal: InterruptEscalationSignal): Promise<void> | void;
  sleep(ms: number): Promise<void>;
}

export interface InterruptLivenessProbe {
  alive: boolean;
  confirmedDead: boolean;
  note?: string;
  unconfirmedPids?: number[];
}

const ESCALATION_STEPS: ReadonlyArray<{ signal: InterruptEscalationSignal; waitMs: number }> = [
  { signal: 'SIGINT', waitMs: 1_000 },
  { signal: 'SIGTERM', waitMs: 1_500 },
  { signal: 'SIGKILL', waitMs: 2_000 },
];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const execFileAsync = promisify(execFile);

interface PosixProcessTreeState {
  processGroupId: number;
  trackedPids: Set<number>;
  rootObserved: boolean;
  groupObserved: boolean;
  verificationFailures: Map<number, string>;
}

interface DefaultInterruptState {
  posixTree?: PosixProcessTreeState;
  treeKillConfirmed: boolean;
}

function createDefaultInterruptState(target: InterruptEscalationTarget): DefaultInterruptState {
  const pid = target.pid;
  return {
    treeKillConfirmed: false,
    ...(process.platform !== 'win32' && pid
      ? {
          posixTree: {
            processGroupId: target.processGroupId && target.processGroupId > 0
              ? target.processGroupId
              : pid,
            trackedPids: new Set([pid]),
            rootObserved: false,
            groupObserved: false,
            verificationFailures: new Map(),
          },
        }
      : {}),
  };
}

function errnoCode(error: unknown): string | number | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function pidList(values: Iterable<number>): number[] {
  return [...new Set(values)].filter((pid) => Number.isSafeInteger(pid) && pid > 0).sort((a, b) => a - b);
}

async function directChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { windowsHide: true });
    return pidList(stdout.split(/\s+/).map((value) => Number.parseInt(value, 10)));
  } catch (error) {
    // pgrep uses exit 1 for a successful query with no matches.
    if (errnoCode(error) === 1) return [];
    throw new Error(`pgrep -P ${pid} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function snapshotPosixDescendants(state: PosixProcessTreeState): Promise<void> {
  const queue = pidList(state.trackedPids);
  const visited = new Set<number>();
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    if (visited.has(parentPid)) continue;
    if (!isPidAlive(parentPid)) {
      state.verificationFailures.delete(parentPid);
      continue;
    }
    visited.add(parentPid);
    let children: number[];
    try {
      children = await directChildPids(parentPid);
      state.verificationFailures.delete(parentPid);
    } catch (error) {
      state.verificationFailures.set(parentPid, error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const childPid of children) {
      if (!state.trackedPids.has(childPid)) state.trackedPids.add(childPid);
      queue.push(childPid);
    }
  }
}

type PosixLiveness = 'alive' | 'dead' | 'unknown';

function probePosixSignalTarget(pid: number): PosixLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (errnoCode(error) === 'EPERM') return 'alive';
    if (errnoCode(error) === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function probePosixProcessGroup(processGroupId: number): PosixLiveness {
  return probePosixSignalTarget(-processGroupId);
}

async function posixProcessGroupId(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)], { windowsHide: true });
    const processGroupId = Number.parseInt(stdout.trim(), 10);
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
  } catch {
    return null;
  }
}

function signalPid(pid: number, signal: InterruptEscalationSignal): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return;
    throw error;
  }
}

/**
 * The mechanism `defaultKill` will use for this target on this platform.
 *
 * Derived rather than reported back by the kill so it is recorded correctly on
 * the FAILURE path too — a taskkill that was denied is still a taskkill, and
 * labelling that attempt 'SIGINT' is exactly the claim this exists to stop.
 */
export function interruptMechanism(
  target: InterruptEscalationTarget,
  signal: InterruptEscalationSignal,
): InterruptEscalationMechanism {
  // The tmux bridge delivers the real signal, whatever the host platform.
  if (target.tmuxSession) return signal;
  if (process.platform !== 'win32') return signal;
  return 'taskkill-tree';
}

async function defaultIsAlive(
  target: InterruptEscalationTarget,
  state: DefaultInterruptState,
): Promise<InterruptLivenessProbe> {
  if (target.tmuxSession) {
    if (await isBridgeSessionAlive(target.tmuxSession, { requireConfirmation: true })) {
      return { alive: true, confirmedDead: false };
    }
    if (target.processMarker && await probeOwnedRunMarker(target.processMarker) !== 'clear') {
      return { alive: true, confirmedDead: false, note: 'Bridge process marker is still live or unconfirmed.' };
    }
    if (!target.pid) return { alive: false, confirmedDead: true };
  }

  if (!target.pid) return { alive: false, confirmedDead: true };

  if (process.platform === 'win32') {
    if (isPidAlive(target.pid)) {
      return { alive: true, confirmedDead: false, unconfirmedPids: [target.pid] };
    }
    if (state.treeKillConfirmed) return { alive: false, confirmedDead: true };
    return {
      alive: true,
      confirmedDead: false,
      unconfirmedPids: [target.pid],
      note: `Pid ${target.pid} was absent before a process-tree kill could verify its descendants stopped.`,
    };
  }

  const tree = state.posixTree!;
  const rootStatus = probePosixSignalTarget(target.pid);
  if (rootStatus === 'alive') tree.rootObserved = true;
  await snapshotPosixDescendants(tree);

  const groupStatus = probePosixProcessGroup(tree.processGroupId);
  if (groupStatus === 'alive') tree.groupObserved = true;
  const trackedStatuses = pidList(tree.trackedPids).map((pid) => ({
    pid,
    status: probePosixSignalTarget(pid),
  }));
  const livePids = trackedStatuses
    .filter(({ status }) => status === 'alive')
    .map(({ pid }) => pid);
  if (groupStatus === 'alive' || livePids.length > 0) {
    return {
      alive: true,
      confirmedDead: false,
      unconfirmedPids: livePids.length > 0 ? livePids : [tree.processGroupId],
    };
  }

  const failedPids = pidList(tree.verificationFailures.keys());
  const unknownPids = pidList([
    ...failedPids,
    ...trackedStatuses
      .filter(({ status }) => status === 'unknown')
      .map(({ pid }) => pid),
    ...(rootStatus === 'unknown' ? [target.pid] : []),
    ...(groupStatus === 'unknown' ? [tree.processGroupId] : []),
  ]);
  if (unknownPids.length > 0) {
    return {
      alive: true,
      confirmedDead: false,
      unconfirmedPids: unknownPids,
      note: `Process-tree verification failed for pids ${unknownPids.join(', ')}.`,
    };
  }

  if (!tree.rootObserved && !tree.groupObserved) {
    return {
      alive: false,
      confirmedDead: true,
      note: `Pid ${target.pid} and process group ${tree.processGroupId} were decisively absent; no addressable process existed.`,
    };
  }

  return { alive: false, confirmedDead: true };
}

async function defaultKill(
  target: InterruptEscalationTarget,
  signal: InterruptEscalationSignal,
  state: DefaultInterruptState,
): Promise<void> {
  if (target.tmuxSession) {
    await signalBridgeTerminalSession(target.tmuxSession, signal);
    return;
  }
  if (!target.pid) return;
  if (target.processIdentityRequired || target.processIdentity) {
    const proof = await probeOwnedSignalIdentity(target);
    if (proof.state !== 'match') throw new Error('Worker start identity changed or is unavailable; no signal was sent.');
  }
  if (process.platform === 'win32') {
    // Windows has no negative-pid process groups, and the recorded pid is the
    // INTERPRETER — the runtime CLI is its child. TerminateProcess on the
    // interpreter alone leaves the agent running while isPidAlive(pid) goes
    // false, which reported `confirmedDead: true` for a worker that was still
    // editing files. A silent no-op is bad; a false confirmation of death on
    // the operator's stop button is worse.
    const { forceKillTreeWindows } = await import('@/lib/runtimes/shared/owned-session/helpers');
    // Windows has one mechanism here, so every rung of the ladder is the same
    // hard tree-kill. Say so rather than letting the audit trail record a
    // graceful SIGINT that was really a /F, and surface a failed kill instead
    // of leaving the caller to infer success from a liveness check.
    // taskkill exits non-zero both when it is DENIED and when the pid is
    // already gone. Those are opposite outcomes and the recorded pid cannot
    // distinguish them: it is the interpreter, and the CLI grandchild can
    // outlive it. Report the failure either way rather than inferring success
    // from the interpreter's absence — inferring is precisely how this path
    // reported confirmedDead for a worker that was still editing files.
    if (!await forceKillTreeWindows(target.pid)) {
      throw new Error(
        `taskkill could not confirm the process tree for pid ${target.pid} was stopped (requested ${signal})`,
      );
    }
    state.treeKillConfirmed = true;
    return;
  }

  const tree = state.posixTree!;
  await snapshotPosixDescendants(tree);
  const snapshotError = tree.verificationFailures.size > 0
    ? [...tree.verificationFailures.entries()]
      .map(([pid, error]) => `${pid} (${error})`)
      .join(', ')
    : null;

  let groupSignaled = false;
  let groupSignalError: string | undefined;
  const strictIdentity = Boolean(target.processIdentityRequired || target.processIdentity);
  // Snapshotting descendants awaits OS queries. Recheck the leader immediately
  // before signaling; an absent leader cannot authorize a possibly reused PGID.
  if (strictIdentity && (await probeOwnedSignalIdentity(target)).state !== 'match') {
    throw new Error('Worker identity is no longer verified; no process group was signaled.');
  }
  try {
    process.kill(-tree.processGroupId, signal);
    tree.groupObserved = true;
    groupSignaled = true;
  } catch (error) {
    if (errnoCode(error) !== 'ESRCH') {
      groupSignalError = error instanceof Error ? error.message : String(error);
    }
  }

  // A worker can escape the recorded process group while it remains a
  // descendant of the interpreter. Signal those descendants explicitly. When
  // the group is unavailable, this becomes the portable POSIX tree-kill
  // fallback instead of signaling only the interpreter and losing the child
  // when it reparents.
  const tracked = pidList(tree.trackedPids).sort((a, b) => b - a);
  const unaddressed: number[] = [];
  for (const pid of tracked) {
    if (!isPidAlive(pid)) continue;
    if (groupSignaled) {
      const processGroupId = await posixProcessGroupId(pid);
      if (processGroupId === tree.processGroupId) continue;
      if (processGroupId === null && !isPidAlive(pid)) continue;
    }
    // Escaped descendants have no persisted start cookie. Keep Stop unconfirmed
    // rather than sending a later rung to a potentially reused descendant PID.
    if (strictIdentity) { unaddressed.push(pid); continue; }
    try {
      signalPid(pid, signal);
    } catch {
      unaddressed.push(pid);
    }
  }
  if (unaddressed.length > 0) {
    const groupContext = groupSignalError
      ? ` Process group ${tree.processGroupId} also failed: ${groupSignalError}.`
      : '';
    throw new Error(
      `Could not signal process-tree pids ${pidList(unaddressed).join(', ')} with ${signal}.${groupContext}`,
    );
  }
  if (snapshotError) {
    throw new Error(`Could not snapshot the complete process tree before ${signal}: ${snapshotError}`);
  }
  if (!groupSignaled && !tree.rootObserved && !tree.groupObserved) {
    throw new Error(
      `Pid ${target.pid} and process group ${tree.processGroupId} were absent before the process tree could be signaled with ${signal}.`,
    );
  }
  if (!groupSignaled && groupSignalError && probePosixProcessGroup(tree.processGroupId) !== 'dead') {
    throw new Error(
      `Could not signal process group ${tree.processGroupId} with ${signal}: ${groupSignalError}`,
    );
  }
}

function normalizeProbe(value: boolean | InterruptLivenessProbe): InterruptLivenessProbe {
  if (typeof value !== 'boolean') {
    if (value.confirmedDead) return { ...value, alive: false };
    return { ...value, alive: true };
  }
  return { alive: value, confirmedDead: !value };
}

async function probeLiveness(
  deps: InterruptEscalationDeps,
  target: InterruptEscalationTarget,
): Promise<InterruptLivenessProbe> {
  try {
    return normalizeProbe(await deps.isAlive(target));
  } catch (error) {
    return {
      alive: true,
      confirmedDead: false,
      note: error instanceof Error ? error.message : String(error),
      unconfirmedPids: target.pid ? [target.pid] : undefined,
    };
  }
}

export async function escalateInterrupt(
  target: InterruptEscalationTarget,
  deps: Partial<InterruptEscalationDeps> = {},
): Promise<InterruptEscalationResult> {
  const defaultState = createDefaultInterruptState(target);
  const runtimeDeps: InterruptEscalationDeps = {
    isAlive: deps.isAlive ?? ((probeTarget) => defaultIsAlive(probeTarget, defaultState)),
    kill: deps.kill ?? ((killTarget, signal) => defaultKill(killTarget, signal, defaultState)),
    sleep: deps.sleep ?? defaultSleep,
  };
  const steps: InterruptEscalationStep[] = [];

  const initialProbe = await probeLiveness(runtimeDeps, target);
  if (initialProbe.confirmedDead) {
    return {
      attempted: false,
      confirmedDead: true,
      alreadyDead: true,
      steps,
      pid: target.pid,
      tmuxSession: target.tmuxSession,
      note: 'No live process was attached to this session.',
    };
  }

  for (const step of ESCALATION_STEPS) {
    const mechanism = interruptMechanism(target, step.signal);
    let sent = false;
    let error: string | undefined;
    try {
      await runtimeDeps.kill(target, step.signal);
      sent = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await runtimeDeps.sleep(step.waitMs);
    const probe = await probeLiveness(runtimeDeps, target);
    const aliveAfter = !probe.confirmedDead;
    steps.push({
      signal: step.signal,
      mechanism,
      sent,
      confirmedDead: probe.confirmedDead,
      aliveAfter,
      error,
      verificationNote: probe.note,
      unconfirmedPids: probe.unconfirmedPids,
    });
    if (probe.confirmedDead) {
      return {
        attempted: true,
        confirmedDead: true,
        alreadyDead: false,
        steps,
        pid: target.pid,
        tmuxSession: target.tmuxSession,
        note: `Worker stopped after ${mechanism}.`,
      };
    }
  }

  const finalStep = steps.at(-1);
  const unconfirmedPids = pidList(finalStep?.unconfirmedPids ?? (target.pid ? [target.pid] : []));
  const verificationSuffix = finalStep?.verificationNote
    ? ` ${finalStep.verificationNote}`
    : unconfirmedPids.length > 0
      ? ` Unconfirmed pids: ${unconfirmedPids.join(', ')}.`
      : '';

  return {
    attempted: true,
    confirmedDead: false,
    alreadyDead: false,
    steps,
    pid: target.pid,
    tmuxSession: target.tmuxSession,
    note: `Worker tree could not be confirmed stopped after ${describeAttempts(steps)}.${verificationSuffix}`,
  };
}

/**
 * Name what was tried, without repeating one mechanism three times. Windows
 * runs the same tree-kill on every rung, so "SIGINT, SIGTERM, and SIGKILL"
 * would describe an escalation that never happened.
 */
function describeAttempts(steps: InterruptEscalationStep[]): string {
  const mechanisms = [...new Set(steps.map((step) => step.mechanism))];
  if (mechanisms.length === 1 && steps.length > 1) {
    return `${steps.length} ${mechanisms[0]} attempts`;
  }
  if (mechanisms.length > 1) {
    return `${mechanisms.slice(0, -1).join(', ')}, and ${mechanisms[mechanisms.length - 1]}`;
  }
  return mechanisms[0] ?? 'no attempts';
}

function ownedRuntimeCommandLabel(surfaceId: string): string | null {
  const registered = getOwnedSessionLifecycle(surfaceId);
  if (registered) return registered.commandLabel;
  if (surfaceId.startsWith('codex-owned:')) return 'codex';
  if (surfaceId.startsWith('claude-code-owned:')) return 'claude';
  if (surfaceId.startsWith('gemini-owned:')) return 'gemini';
  if (surfaceId.startsWith('opencode-owned:')) return 'opencode2';
  if (surfaceId.startsWith('cursor-owned:')) return 'cursor-agent';
  if (surfaceId.startsWith('grok-owned:')) return 'grok';
  if (surfaceId.startsWith('prime-agent-owned:')) return 'prime-agent';
  if (surfaceId.startsWith('pi-owned:')) return 'pi';
  return null;
}

export async function escalateInterruptOwnedSurface(surfaceId: string): Promise<InterruptEscalationResult | null> {
  // Declarative owned runtimes register lazily with the runtime catalogue. A
  // persisted lane can reach this path before any discovery call, so load the
  // catalogue before resolving its lifecycle authority.
  await import('@/lib/runtimes');
  const commandLabel = ownedRuntimeCommandLabel(surfaceId);
  if (!commandLabel) return null;

  const activeRun = await lookupOwnedActiveRunFresh(surfaceId);
  if (!activeRun) {
    return {
      attempted: false,
      confirmedDead: false,
      alreadyDead: false,
      steps: [],
      note: 'Owned runtime process evidence is unavailable, so the worker tree could not be confirmed stopped.',
    };
  }

  if (!activeRun.pid && !activeRun.tmuxSession) {
    // The index returns {} only for a cleared activeRun. A prepared run has
    // identity fields but no process yet; its pending spawn is not exit proof.
    if (Object.keys(activeRun).length > 0) {
      return {
        attempted: false,
        confirmedDead: false,
        alreadyDead: false,
        steps: [],
        note: 'The owned run has no process identity yet; Stop remains held until its process state can be confirmed.',
      };
    }
    return {
      attempted: false,
      confirmedDead: true,
      alreadyDead: true,
      steps: [],
      note: 'The owned runtime recorded no active run.',
    };
  }

  if (activeRun.supervisor) {
    return withOwnedStopOutcome(surfaceId, activeRun, () => escalateInterrupt({ pid: activeRun.pid }, {
      isAlive: async () => {
        const state = await attachSupervisedRun({ ...activeRun, id: activeRun.id!, pid: activeRun.pid! }, surfaceId);
        // A leader's exit alone does not prove its entire group is gone.
        return { alive: !state.groupEmpty, confirmedDead: state.groupEmpty };
      },
      kill: async (_target, signal) => { await ownedSupervisorClient().signal(activeRun.supervisor!, signal); },
      sleep: defaultSleep,
    }));
  }

  if (!activeRun.tmuxSession && (activeRun.processIdentityRequired || activeRun.processIdentity)) {
    const proof = await probeOwnedSignalIdentity(activeRun);
    if (proof.state !== 'match') {
      return { attempted: false, confirmedDead: false, alreadyDead: false, steps: [], pid: activeRun.pid,
        note: 'Worker start identity changed or is unavailable; the run remains held and no process was signaled.' };
    }
  }

  // The bridge is the durable owner when present. Wrapper pids can go stale or
  // be replaced after exec while the tmux session remains alive, so a reused
  // pid must never override positive bridge liveness.
  const bridgeAlive = activeRun.tmuxSession
    ? await isBridgeSessionAlive(activeRun.tmuxSession, { requireConfirmation: true })
    : false;
  if (activeRun.pid && !bridgeAlive) {
    const expectedCommand = activeRun.commandIdentity ?? commandLabel;
    const pidAlive = isPidAlive(activeRun.pid);
    const commandLine = surfaceId.startsWith('opencode-owned:')
      || process.platform === 'win32'
      || !pidAlive
      ? await pidCommandLine(activeRun.pid)
      : null;
    const commandClassification = classifyOwnedRunCommandLine(
      commandLine,
      activeRun.commandIdentity,
      commandLabel,
    );
    let identityMatches: boolean;
    if (process.platform !== 'win32' && pidAlive) {
      // A launcher can exec the runtime without changing PID. The persisted
      // run marker survives that transition; a binary name does not. Require
      // both the exact PID's marker and its recorded group before signaling.
      // Missing/unknown proof must never fall back to a matching command name.
      const claim = activeRun.processMarker ? await probeOwnedRunProcessClaim({
        pid: activeRun.pid, marker: activeRun.processMarker, rootPid: activeRun.pid,
      }) : null;
      const group = claim?.state === 'match'
        ? await resolveSpawnedProcessGroupId(activeRun.pid)
        : undefined;
      identityMatches = commandClassification !== 'resident-service'
        && claim?.state === 'match'
        && group !== undefined
        && group === (activeRun.processGroupId ?? activeRun.pid);
    } else {
      identityMatches = commandLine
        ? commandClassification === 'owned-run'
        : !pidAlive;
    }
    if (!identityMatches) {
      return {
        attempted: false,
        confirmedDead: false,
        alreadyDead: false,
        steps: [],
        pid: activeRun.pid,
        tmuxSession: activeRun.tmuxSession,
        note: commandClassification === 'resident-service'
          ? 'The stored pid belongs to the resident service, not the packet worker. The service was not signaled, and worker exit remains unconfirmed.'
          : `Stored pid ${activeRun.pid} could not be verified as the owned ${expectedCommand} run, so its process tree was not signaled or confirmed stopped. Legacy runs require an owner-verified stop before retry.`,
      };
    }
  }

  return withOwnedStopOutcome(surfaceId, activeRun, () => escalateInterrupt({
    pid: activeRun.pid,
    processIdentity: activeRun.processIdentity,
    processIdentitySource: activeRun.processIdentitySource,
    processIdentityRequired: activeRun.processIdentityRequired,
    processGroupId: activeRun.processGroupId,
    processMarker: activeRun.processMarker,
    tmuxSession: activeRun.tmuxSession,
    commandLabel,
  }));
}
