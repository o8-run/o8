import { execFile } from '@/lib/providers/child-process';
import type {
  ManagedRunRecord,
  ManagedRunTerminationReceipt,
  ManagedRunTerminationSignal,
} from './types';
import { externalSettlementQuiet } from './settlement';
import { findManagedRun, requestManagedRunStop, retainManagedRunTermination } from './registry';

interface CommandReceipt {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ManagedRunTerminationDeps {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandReceipt>;
  signalProcess(pid: number, signal: ManagedRunTerminationSignal): void;
  signalGroup(processGroupId: number, signal: ManagedRunTerminationSignal): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

const STEPS: ReadonlyArray<{ signal: ManagedRunTerminationSignal; waitMs: number }> = [
  { signal: 'SIGINT', waitMs: 800 },
  { signal: 'SIGTERM', waitMs: 1_200 },
  { signal: 'SIGKILL', waitMs: 1_500 },
];

export const MANAGED_RUN_PROCESS_PROBE_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function defaultRun(command: string, args: string[], timeoutMs: number): Promise<CommandReceipt> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: MANAGED_RUN_PROCESS_PROBE_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const numericCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException).code)
        : error ? 127 : 0;
      resolve({ code: numericCode, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function defaultSignalProcess(pid: number, signal: ManagedRunTerminationSignal): void {
  process.kill(pid, signal);
}

function defaultSignalGroup(processGroupId: number, signal: ManagedRunTerminationSignal): void {
  process.kill(-processGroupId, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePids(output: string): number[] {
  return output
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function sessionProbe(
  record: ManagedRunRecord,
  deps: ManagedRunTerminationDeps,
): Promise<{ alive: boolean; processGroupId: number | null; error?: string }> {
  const live = await deps.run('tmux', ['has-session', '-t', record.session], 3_000);
  if (live.code === 1) return { alive: false, processGroupId: null };
  if (live.code !== 0) {
    return {
      alive: true,
      processGroupId: null,
      error: live.stderr.trim() || `tmux probe exited ${live.code}`,
    };
  }
  const pane = await deps.run('tmux', ['list-panes', '-t', record.session, '-F', '#{pane_pid}'], 3_000);
  const panePid = Number.parseInt(pane.stdout.trim(), 10);
  if (pane.code !== 0 || !Number.isSafeInteger(panePid) || panePid <= 0) {
    return { alive: true, processGroupId: null, error: 'owned tmux pane identity is unavailable' };
  }
  const group = await deps.run('ps', ['-o', 'pgid=', '-p', String(panePid)], 2_000);
  const processGroupId = Number.parseInt(group.stdout.trim(), 10);
  if (group.code !== 0 || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    return { alive: true, processGroupId: null, error: 'owned process-group identity is unavailable' };
  }
  if (record.processGroupId && record.processGroupId !== processGroupId) {
    return {
      alive: true,
      processGroupId: null,
      error: `owned process group changed from ${record.processGroupId} to ${processGroupId}`,
    };
  }
  return { alive: true, processGroupId };
}

async function markerProbe(
  marker: string | null | undefined,
  deps: ManagedRunTerminationDeps,
): Promise<{ state: 'live' | 'clear' | 'not_applicable' | 'unknown'; pids: number[]; error?: string }> {
  if (!marker) return { state: 'not_applicable', pids: [] };
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(marker)) {
    return { state: 'unknown', pids: [], error: 'owned process marker is invalid' };
  }
  const receipt = await deps.run('ps', ['axeww', '-o', 'pid=,command='], 3_000);
  if (receipt.code !== 0) {
    return {
      state: 'unknown',
      pids: [],
      error: receipt.stderr.trim() || `marker probe exited ${receipt.code}`,
    };
  }
  const needle = `O8_MANAGED_RUN_MARKER=${marker}`;
  const pids = receipt.stdout.split('\n').flatMap((line) => {
    if (!line.includes(needle)) return [];
    return parsePids(line.trim().split(/\s+/, 1)[0] ?? '');
  });
  return { state: pids.length > 0 ? 'live' : 'clear', pids };
}

async function probeOwnedRun(record: ManagedRunRecord, deps: ManagedRunTerminationDeps) {
  const [session, marker] = await Promise.all([
    sessionProbe(record, deps),
    markerProbe(record.processMarker, deps),
  ]);
  const confirmedDead = !session.alive
    && (marker.state === 'clear' || marker.state === 'not_applicable');
  return { session, marker, confirmedDead };
}

function defaultDependencies(): ManagedRunTerminationDeps {
  return { run: defaultRun, signalProcess: defaultSignalProcess, signalGroup: defaultSignalGroup,
    sleep: defaultSleep, now: () => new Date() };
}

/** Signal-free process-tree verification, also used before natural completion. */
export async function inspectOwnedManagedRun(record: ManagedRunRecord): Promise<boolean> {
  return (await probeOwnedRun(record, defaultDependencies())).confirmedDead;
}

export async function terminateManagedRun(
  record: ManagedRunRecord,
  options: {
    reason: 'stream_sigint' | 'operator_stop';
    exitCode: number | null;
    deps?: Partial<ManagedRunTerminationDeps>;
  },
): Promise<ManagedRunTerminationReceipt> {
  if (record.workspaceService) {
    const { stopManagedWorkspaceService } = await import('@/lib/workspace/manifest/services');
    await stopManagedWorkspaceService(record);
  }
  if (record.settlement) record = requestManagedRunStop(record.id) ?? record;
  const deps: ManagedRunTerminationDeps = {
    run: options.deps?.run ?? defaultRun,
    signalProcess: options.deps?.signalProcess ?? defaultSignalProcess,
    signalGroup: options.deps?.signalGroup ?? defaultSignalGroup,
    sleep: options.deps?.sleep ?? defaultSleep,
    now: options.deps?.now ?? (() => new Date()),
  };
  const requestedAt = deps.now().toISOString();
  const externalQuiet = () => externalSettlementQuiet(findManagedRun(record.id) ?? record);
  const settle = (receipt: ManagedRunTerminationReceipt) => {
    if (record.settlement) {
      receipt.externalSettlement = externalQuiet() ? 'quiet' : 'unknown';
      receipt.confirmedDead = receipt.confirmedDead && receipt.externalSettlement === 'quiet';
      if (!receipt.confirmedDead) receipt.confirmedAt = null;
      retainManagedRunTermination(record.id, receipt);
    }
    return receipt;
  };
  const waitForExternal = async () => {
    // A coordinator needs time to stop remote/independently contained work.
    // The operator callback can run concurrently; workers cannot write it.
    for (let elapsed = 0; record.settlement && !externalQuiet() && elapsed < 10_000; elapsed += 250) {
      await deps.sleep(250);
    }
  };
  const before = await probeOwnedRun(record, deps);
  if (before.confirmedDead) {
    await waitForExternal();
    return settle({
      schema: 'o8/managed-run-termination/v1',
      reason: options.reason,
      exitCode: options.exitCode,
      requestedAt,
      confirmedAt: deps.now().toISOString(),
      confirmedDead: true,
      alreadyDead: true,
      steps: [],
    });
  }

  const steps: ManagedRunTerminationReceipt['steps'] = [];
  for (const step of STEPS) {
    const probe = await probeOwnedRun(record, deps);
    const errors = [probe.session.error, probe.marker.error].filter(Boolean) as string[];
    let groupSignaled = false;
    const signaledPids: number[] = [];

    if (probe.session.processGroupId) {
      try {
        deps.signalGroup(probe.session.processGroupId, step.signal);
        groupSignaled = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const pid of probe.marker.pids) {
      try {
        deps.signalProcess(pid, step.signal);
        signaledPids.push(pid);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (step.signal === 'SIGKILL' && probe.session.alive) {
      const killedSession = await deps.run('tmux', ['kill-session', '-t', record.session], 5_000);
      if (killedSession.code !== 0 && killedSession.code !== 1) {
        errors.push(killedSession.stderr.trim() || `tmux kill-session exited ${killedSession.code}`);
      }
    }

    await deps.sleep(step.waitMs);
    if (record.settlement && step.signal === 'SIGINT') await waitForExternal();
    const after = await probeOwnedRun(record, deps);
    steps.push({
      signal: step.signal,
      groupSignaled,
      signaledPids,
      sessionAliveAfter: after.session.alive,
      markerPidsAfter: after.marker.pids,
      errors,
    });
    if (after.confirmedDead) {
      return settle({
        schema: 'o8/managed-run-termination/v1',
        reason: options.reason,
        exitCode: options.exitCode,
        requestedAt,
        confirmedAt: deps.now().toISOString(),
        confirmedDead: true,
        alreadyDead: false,
        steps,
      });
    }
  }

  return settle({
    schema: 'o8/managed-run-termination/v1',
    reason: options.reason,
    exitCode: options.exitCode,
    requestedAt,
    confirmedAt: null,
    confirmedDead: false,
    alreadyDead: false,
    steps,
  });
}

export const managedRunTerminationInternals = {
  markerProbe,
  parsePids,
  probeOwnedRun,
  sessionProbe,
};
