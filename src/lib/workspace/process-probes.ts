import { hasCloseProcessObservation } from '@/lib/runtime/close-process-observation';
import { closeProcessCommand } from '@/lib/runtime/close-process-table';
import { observeCloseProcess } from '@/lib/runtime/close-process-observation';
import { execFile } from '@/lib/providers/child-process';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import {
  parseProcessCwdSnapshot,
  processCwdRowsInside,
  processCwdSnapshotFromRows,
  readProcessCwdSnapshot,
  type ProcessCwdSnapshot,
} from '@/lib/runtime/process-cwd-snapshot';
import {
  processProbe,
  synthesizeProcessQuiescence,
  type ProcessQuiescenceReceipt,
  type ProcessProbeReceipt,
} from './process-quiescence';
import { summarizeProcessProbeDetails } from './retirement-refusal-diagnostics';

interface CommandReceipt {
  code: number;
  stdout: string;
  stderr: string;
}

export interface OwnedProcessProbeOptions {
  /** Exact terminal retirement only; archival never grants execution authority. */
  allowArchivedRetirement?: true;
  /** Quiescent archive recovery; never authorizes a provider run. */
  allowArchivedRecovery?: true;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<CommandReceipt>;
  readCwdSnapshot?: () => Promise<ProcessCwdSnapshot>;
  now?: () => Date;
}

type RetainedRunIdentity = OwnedWorkspaceBindingReceipt['retainedRuns'][number];
type PidIdentity = ProcessQuiescenceReceipt['identity']['pidIdentity'];

interface RetainedRunProbe {
  run: RetainedRunIdentity;
  pidIdentity: PidIdentity;
  processGroupId?: number;
  probes: ProcessProbeReceipt[];
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandReceipt> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as NodeJS.ErrnoException & { code: number }).code
        : error ? 127 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function commandUnavailable(receipt: CommandReceipt): boolean {
  return receipt.code === 127 || /not found|ENOENT/i.test(receipt.stderr);
}

function parsePids(raw: string): number[] {
  return raw
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function machineCwdSnapshot(
  options: OwnedProcessProbeOptions,
  run: NonNullable<OwnedProcessProbeOptions['run']>,
): Promise<ProcessCwdSnapshot> {
  if (options.readCwdSnapshot) return options.readCwdSnapshot();
  // Close owns explicit refreshes at admission, rename, paused purge and final
  // removal. Projections within one such boundary share its native evidence.
  if (!options.run) return readProcessCwdSnapshot({ forceRefresh: !hasCloseProcessObservation() });
  const receipt = await run('lsof', ['-nP', '-d', 'cwd', '-F', 'pcLftn'], 3_000);
  if (receipt.code === 0) {
    return processCwdSnapshotFromRows(parseProcessCwdSnapshot(receipt.stdout), Date.now());
  }
  if (receipt.code === 1 && !receipt.stdout.trim() && !receipt.stderr.trim()) {
    return { status: 'ready', rows: [], capturedAt: Date.now() };
  }
  return {
    status: 'unavailable',
    rows: [],
    capturedAt: Date.now(),
    reason: receipt.stderr.trim() || `lsof cwd snapshot exited ${receipt.code}`,
  };
}

async function probeDescendants(
  rootPid: number,
  run: NonNullable<OwnedProcessProbeOptions['run']>,
): Promise<ProcessProbeReceipt> {
  const seen = new Set<number>();
  let frontier = [rootPid];
  for (let depth = 0; frontier.length > 0 && depth < 32; depth += 1) {
    const next: number[] = [];
    for (const pid of frontier) {
      const receipt = await run('pgrep', ['-P', String(pid)], 2_000);
      if (commandUnavailable(receipt)) {
        return processProbe('descendants', 'unknown', 'pgrep is unavailable, so descendants could not be proved absent.');
      }
      if (receipt.code !== 0 && receipt.code !== 1) {
        return processProbe('descendants', 'unknown', `pgrep failed with exit ${receipt.code}.`);
      }
      for (const child of parsePids(receipt.stdout)) {
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) {
    return processProbe('descendants', 'unknown', 'Descendant traversal exceeded its depth bound.');
  }
  const pids = [...seen];
  return pids.length > 0
    ? processProbe('descendants', 'live', 'Owned process descendants are still live.', pids)
    : processProbe('descendants', 'clear', 'No owned process descendants are live.');
}

function aggregateRunProbe(
  primitive: ProcessProbeReceipt['primitive'],
  runProbes: RetainedRunProbe[],
): ProcessProbeReceipt {
  if (runProbes.length === 0) {
    return processProbe(primitive, 'clear', `No retained owned run has ${primitive} identity.`);
  }
  const receipts = runProbes.map((entry) => ({
    runId: entry.run.id,
    receipt: entry.probes.find((probe) => probe.primitive === primitive),
  }));
  const missing = receipts.filter((entry) => !entry.receipt);
  if (missing.length > 0) {
    return processProbe(
      primitive,
      'unknown',
      `Retained run probe coverage is incomplete for ${primitive}.`,
    );
  }
  const state = receipts.some((entry) => entry.receipt?.state === 'live')
    ? 'live'
    : receipts.some((entry) => entry.receipt?.state === 'unknown')
      ? 'unknown'
      : 'clear';
  const relevant = receipts.filter((entry) => entry.receipt?.state === state);
  const pids = relevant.flatMap((entry) => entry.receipt?.pids ?? []);
  const detail = state === 'clear'
    ? `All ${runProbes.length} retained owned runs are clear for ${primitive}.`
    : summarizeProcessProbeDetails(receipts.flatMap((entry) => entry.receipt?.state !== 'clear' && entry.receipt ? [entry.receipt] : []));
  return processProbe(primitive, state, detail, pids.length > 0 ? pids : undefined);
}

async function probeRetainedRun(
  runIdentity: RetainedRunIdentity,
  run: NonNullable<OwnedProcessProbeOptions['run']>,
): Promise<RetainedRunProbe> {
  const probes: ProcessProbeReceipt[] = [];
  let pidIdentity: PidIdentity = 'not_applicable';
  let processGroupId = Number.isInteger(runIdentity.processGroupId) && (runIdentity.processGroupId ?? 0) > 0
    ? runIdentity.processGroupId
    : undefined;

  if (!Number.isInteger(runIdentity.pid) || runIdentity.pid <= 0) {
    pidIdentity = 'unknown';
    probes.push(processProbe('pid', 'unknown', 'The retained run has no valid PID identity.'));
  } else {
    const process = await run('ps', ['-o', 'pgid=,command=', '-p', String(runIdentity.pid)], 2_000);
    if (commandUnavailable(process)) {
      pidIdentity = 'unknown';
      probes.push(processProbe('pid', 'unknown', 'ps is unavailable, so PID identity could not be checked.'));
    } else if (process.code === 1 || !process.stdout.trim()) {
      probes.push(processProbe('pid', 'clear', 'The recorded owned PID is absent.'));
    } else if (process.code !== 0) {
      pidIdentity = 'unknown';
      probes.push(processProbe('pid', 'unknown', `ps failed with exit ${process.code}.`));
    } else {
      const match = process.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) {
        pidIdentity = 'unknown';
        probes.push(processProbe('pid', 'unknown', 'ps returned an unreadable process identity.'));
      } else {
        processGroupId = runIdentity.processGroupId ?? Number.parseInt(match[1]!, 10);
        const command = match[2]!;
        pidIdentity = !runIdentity.commandIdentity
          ? 'unknown'
          : command.includes(runIdentity.commandIdentity)
            ? 'matched'
            : 'reused';
        probes.push(processProbe(
          'pid',
          pidIdentity === 'matched' ? 'live' : 'unknown',
          pidIdentity === 'matched'
            ? 'The retained owned PID is still live.'
            : pidIdentity === 'reused'
              ? 'The retained PID belongs to another command.'
              : 'The retained run predates durable command identity.',
          [runIdentity.pid],
        ));
      }
    }
  }

  if (processGroupId) {
    const group = await run('pgrep', ['-g', String(processGroupId)], 2_000);
    if (commandUnavailable(group)) {
      probes.push(processProbe('process_group', 'unknown', 'pgrep is unavailable, so the process group is unknown.'));
    } else if (group.code !== 0 && group.code !== 1) {
      probes.push(processProbe('process_group', 'unknown', `Process-group probe failed with exit ${group.code}.`));
    } else {
      const pids = parsePids(group.stdout);
      probes.push(pids.length > 0
        ? processProbe('process_group', 'live', 'The retained owned process group is still live.', pids)
        : processProbe('process_group', 'clear', 'The retained owned process group is clear.'));
    }
  } else {
    probes.push(processProbe(
      'process_group',
      'unknown',
      'The retained run has no durable process-group identity to probe.',
    ));
  }

  probes.push(Number.isInteger(runIdentity.pid) && runIdentity.pid > 0
    ? await probeDescendants(runIdentity.pid, run)
    : processProbe('descendants', 'unknown', 'The retained run has no valid PID for descendant traversal.'));

  if (runIdentity.processMarker) {
    const marker = await run('ps', ['axeww', '-o', 'pid=,command='], 3_000);
    if (commandUnavailable(marker)) {
      probes.push(processProbe('owned_marker', 'unknown', 'ps cannot scan inherited owned-run markers.'));
    } else if (marker.code !== 0) {
      probes.push(processProbe('owned_marker', 'unknown', `Owned-run marker scan failed with exit ${marker.code}.`));
    } else {
      const needle = `O8_OWNED_RUN_MARKER=${runIdentity.processMarker}`;
      const pids = marker.stdout.split('\n').flatMap((line) => {
        if (!line.includes(needle)) return [];
        const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
        return Number.isInteger(pid) && pid > 0 ? [pid] : [];
      });
      probes.push(pids.length > 0
        ? processProbe('owned_marker', 'live', 'A process still carries the retained owned-run marker.', pids)
        : processProbe('owned_marker', 'clear', 'No process carries the retained owned-run marker.'));
    }
  } else {
    probes.push(processProbe('owned_marker', 'unknown', 'The retained run predates durable owned-run markers.'));
  }

  if (runIdentity.tmuxSession) {
    const tmux = await run('tmux', ['has-session', '-t', runIdentity.tmuxSession], 2_000);
    probes.push(commandUnavailable(tmux)
      ? processProbe('tmux', 'unknown', 'tmux is unavailable, so the retained session cannot be checked.')
      : tmux.code === 0
        ? processProbe('tmux', 'live', 'The retained owned tmux session is still live.')
        : tmux.code === 1
          ? processProbe('tmux', 'clear', 'The retained tmux session is absent.')
          : processProbe('tmux', 'unknown', `tmux probe failed with exit ${tmux.code}.`));
  } else {
    probes.push(processProbe('tmux', 'clear', 'The retained owned run has no tmux session.'));
  }
  probes.push(processProbe(
    'runtime',
    pidIdentity === 'not_applicable' ? 'clear' : pidIdentity === 'matched' ? 'live' : 'unknown',
    pidIdentity === 'matched'
      ? 'The retained runtime metadata and live PID agree.'
      : pidIdentity === 'not_applicable'
        ? 'The retained owned runtime process is absent.'
        : 'The retained owned runtime process identity is uncertain.',
  ));

  return { run: runIdentity, pidIdentity, processGroupId, probes };
}

/**
 * Collect every retained run's process primitives plus durable ledger truth
 * before a workspace can be removed. Missing support returns unknown.
 */
export async function probeOwnedSessionProcessQuiescence(
  surfaceId: string,
  workspacePath: string,
  options: OwnedProcessProbeOptions = {},
): Promise<ProcessQuiescenceReceipt> {
  const lifecycle = getOwnedSessionLifecycle(surfaceId);
  const run = options.run ?? ((command, args, timeoutMs) => observeCloseProcess(
    JSON.stringify([command, args]), async () =>
      (hasCloseProcessObservation() ? await closeProcessCommand(command, args) : null) ?? await runCommand(command, args, timeoutMs),
  ));
  const now = options.now ?? (() => new Date());
  if (!lifecycle?.getWorkspaceBinding) {
    return synthesizeProcessQuiescence(
      { ownership: lifecycle ? 'owned' : 'unowned', pidIdentity: 'unknown', sessionKey: surfaceId },
      [],
      now,
    );
  }
  const receipt = await lifecycle.getWorkspaceBinding(surfaceId).catch(() => null);
  if (!receipt || (receipt.sessionState !== 'active'
    && !((options.allowArchivedRetirement || options.allowArchivedRecovery) && receipt.sessionState === 'archived'
      && receipt.activeRun === null && Array.isArray(receipt.retainedRuns)
      && receipt.retainedRuns.every(runIdentity => runIdentity.outcome !== 'running')))) {
    return synthesizeProcessQuiescence(
      { ownership: receipt ? 'owned' : 'unknown', pidIdentity: 'unknown', sessionKey: surfaceId },
      [],
      now,
    );
  }

  const probes: ProcessProbeReceipt[] = [];
  const retainedRunIds = Array.isArray(receipt.retainedRuns)
    ? receipt.retainedRuns.map((runIdentity) => runIdentity.id)
    : [];
  const retainedRuns = Array.isArray(receipt.retainedRuns)
    && receipt.retainedRuns.length <= 16
    && retainedRunIds.every((runId) => Boolean(runId.trim()))
    && new Set(retainedRunIds).size === retainedRunIds.length
    ? receipt.retainedRuns
    : null;
  const retainedRunLedgerComplete = retainedRuns !== null
    && receipt.retainedRunsComplete === true
    && Number.isSafeInteger(receipt.retainedRunTotal)
    && (receipt.retainedRunTotal ?? -1) >= retainedRuns.length
    && (receipt.retainedRunTotal ?? 17) <= 16;
  const runProbes: RetainedRunProbe[] = [];
  if (retainedRuns) {
    for (const runIdentity of retainedRuns) {
      runProbes.push(await probeRetainedRun(runIdentity, run));
    }
  }
  const pidIdentity: PidIdentity = !retainedRuns
    ? 'unknown'
    : runProbes.some((entry) => entry.pidIdentity === 'reused')
      ? 'reused'
      : runProbes.some((entry) => entry.pidIdentity === 'unknown')
        ? 'unknown'
        : runProbes.some((entry) => entry.pidIdentity === 'matched')
          ? 'matched'
          : 'not_applicable';
  if (!retainedRuns) {
    for (const primitive of ['pid', 'process_group', 'descendants', 'owned_marker', 'tmux', 'runtime'] as const) {
      probes.push(processProbe(
        primitive,
        'unknown',
        'The owned-workspace binding does not contain a bounded retained-run ledger.',
      ));
    }
  } else {
    for (const primitive of ['pid', 'process_group', 'descendants', 'owned_marker', 'tmux', 'runtime'] as const) {
      probes.push(aggregateRunProbe(primitive, runProbes));
    }
  }
  probes.push(processProbe(
    'retained_run_ledger',
    retainedRunLedgerComplete ? 'clear' : 'unknown',
    retainedRunLedgerComplete
      ? 'The bounded retained-run ledger is complete.'
      : 'The retained-run ledger is legacy, corrupt, or permanently incomplete.',
  ));

  const cwdSnapshot = await machineCwdSnapshot(options, run);
  if (cwdSnapshot.status !== 'ready') {
    probes.push(processProbe('filesystem_users', 'unknown', `Machine cwd snapshot failed: ${cwdSnapshot.reason}`));
  } else {
    const cwdUsers = processCwdRowsInside(cwdSnapshot, workspacePath).map((row) => row.pid);
    if (cwdUsers.length > 0) {
      probes.push(processProbe('filesystem_users', 'live', 'Processes still have a cwd under the workspace.', cwdUsers));
    } else {
      probes.push(processProbe('filesystem_users', 'clear', 'No process has a cwd under the workspace.'));
    }
  }

  return synthesizeProcessQuiescence({
    ownership: 'owned',
    pidIdentity,
    sessionKey: surfaceId,
    expectedPid: receipt.activeRun?.pid,
    expectedProcessGroupId: receipt.activeRun?.processGroupId,
    expectedCommandIdentity: receipt.activeRun?.commandIdentity,
    retainedRuns: runProbes.map((entry) => ({
      runId: entry.run.id,
      outcome: entry.run.outcome,
      pid: entry.run.pid,
      pidIdentity: entry.pidIdentity,
      processGroupId: entry.processGroupId,
      commandIdentity: entry.run.commandIdentity,
      processMarker: entry.run.processMarker,
      spawnState: entry.run.spawnState,
      tmuxSession: entry.run.tmuxSession,
    })),
  }, probes, now);
}
