import { readCloseProcessTable } from '@/lib/runtime/close-process-table';
import { parseOpenFileSnapshot, readCloseOpenFiles, readCloseOpenFileRows } from '@/lib/runtime/process-open-files-snapshot';
import { refreshCloseProcessObservation, hasCloseProcessObservation } from '@/lib/runtime/close-process-observation';
import { closeObservedHelperSettled, observeCloseProcess } from '@/lib/runtime/close-process-observation';
import { execFile } from '@/lib/providers/child-process';
import path from 'node:path';
import { promisify } from 'node:util';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { withCapturedPurgeProcessExclusion, type CapturedPurgeProcessWitness } from '@/lib/workspace/exact-directory-purge';

const execFileAsync = promisify(execFile);
export class OrphanCloseRefusal extends Error {
  constructor(reason: string) {
    super(`Close refused: ${reason.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 400)}. The checkout remains held.`);
    this.name = 'OrphanCloseRefusal';
  }
}

export interface OrphanRunIdentity { runId: string; pid: number; processGroupId: number }

async function command(file: string, args: string[], absentExit = false): Promise<string | null> {
  return observeCloseProcess(file === 'lsof' ? 'open-files' : JSON.stringify([file, args, absentExit]),
    () => nativeCommand(file, args, absentExit));
}

async function nativeCommand(file: string, args: string[], absentExit: boolean) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (result.stderr.trim()) throw new OrphanCloseRefusal(`${file} probe returned incomplete output`);
    return result.stdout;
  } catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (absentExit && failed.code === 1 && !failed.stdout?.trim()
      && /no server running|no such file|can't find session|no sessions/i.test(failed.stderr ?? '')) return null;
    throw new OrphanCloseRefusal(`${file} process probe is unavailable or inconclusive`);
  }
}

function processName(commandLine: string): string {
  const name = path.basename(commandLine.trim().split(/\s+/)[0] ?? 'process');
  return /^[A-Za-z0-9._-]{1,60}$/.test(name) ? name : 'process';
}

/** No cached inventory: inspect retained PID/group/marker identities and every open descriptor. */
export async function assertOrphanProcessesAbsent(input: {
  capturedPurge?: CapturedPurgeProcessWitness;
  runtime: string;
  packetId?: string;
  runs: OrphanRunIdentity[];
  sourcePath: string;
  candidatePath: string;
}): Promise<void> {
  if (!input.capturedPurge) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await inspectOrphanProcesses(input); }
      catch (error) {
        if (attempt >= 3 || !(error instanceof OrphanCloseRefusal)
          || (!error.message.includes('has an open file or cwd in the worktree')
            && !error.message.includes('references the packet workspace'))) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
        refreshCloseProcessObservation();
      }
    }
  }
  try {
    await withCapturedPurgeProcessExclusion(input.capturedPurge, input.candidatePath,
      (isHelper) => inspectOrphanProcesses(input, isHelper));
  } catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    throw new OrphanCloseRefusal('paused purge helper process attestation is unavailable or inconclusive');
  }
}

async function inspectOrphanProcesses(input: {
  runtime: string; packetId?: string;
  runs: OrphanRunIdentity[]; sourcePath: string; candidatePath: string;
}, isHelper?: (pid: number) => boolean): Promise<void> {
  const raw = hasCloseProcessObservation() ? '' : await command('ps', ['axeww', '-o', 'pid=,pgid=,ppid=,command=']);
  if (!hasCloseProcessObservation() && !raw?.trim()) throw new OrphanCloseRefusal('ps returned no process identity snapshot');
  const processes = hasCloseProcessObservation() ? await readCloseProcessTable() : raw!.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new OrphanCloseRefusal('ps returned malformed process identity output');
    return { pid: Number(match[1]), group: Number(match[2]), parent: Number(match[3]), command: match[4]! };
  });
  const packetProcess = processes.find(row => !isHelper?.(row.pid) && !closeObservedHelperSettled(row.pid) && (
    (input.packetId && row.command.split(/\s+/).includes(`O8_WORKER_PACKET_ID=${input.packetId}`))
    || (input.packetId && row.command.split(/\s+/).includes(`O8_PACKET_ID=${input.packetId}`))
    || row.command.includes(input.sourcePath) || row.command.includes(input.candidatePath)));
  if (packetProcess) throw new OrphanCloseRefusal(`live process PID ${packetProcess.pid} (${processName(packetProcess.command)}) references the packet workspace`);
  for (const run of input.runs) {
    const live = processes.find((row) => row.pid === run.pid || row.group === run.processGroupId
      || row.parent === run.pid || row.command.split(/\s+/).includes(`O8_OWNED_RUN_MARKER=${run.runId}`));
    // A reused PID/group remains a refusal; token rows confer no signaling authority.
    if (live) throw new OrphanCloseRefusal(`live process PID ${live.pid} (${processName(live.command)}) matches retained run identity`);
    const tmux = await command('tmux', ['has-session', '-t', `=${tmuxSessionName(input.runtime, run.runId)}`], true);
    if (tmux !== null) throw new OrphanCloseRefusal('a retained run tmux session is still live');
  }

  // Request file delimiters explicitly: Linux omits f fields unless selected.
  // Global descriptors also cover deleted files and the source-to-claim rename.
  // Never log this output; only report holders of the two exact namespaces.
  const files = hasCloseProcessObservation()
    ? await readCloseOpenFiles().catch(() => { throw new OrphanCloseRefusal('lsof process probe is unavailable or inconclusive'); })
    : await command('lsof', ['-nP', '-Fpcftn']);
  if (!files?.trim()) throw new OrphanCloseRefusal('lsof returned no open-file snapshot');
  const targets = [input.sourcePath, input.candidatePath].map((target) => path.resolve(target));
  let helperObserved = false;
  let entries;
  try { entries = hasCloseProcessObservation() ? await readCloseOpenFileRows() : parseOpenFileSnapshot(files); }
  catch (error) { throw new OrphanCloseRefusal(error instanceof Error ? error.message : 'lsof protocol is uncertain'); }
  for (const row of entries) {
    if (!targets.some(target => row.file === target || row.file.startsWith(target + path.sep))) continue;
    if (isHelper?.(row.pid)) helperObserved = true;
    else if (!closeObservedHelperSettled(row.pid)) {
      throw new OrphanCloseRefusal(`live process PID ${row.pid} (${row.commandName}) holds ${row.file}. Stop this process and retry Close`);
    }
  }
  if (isHelper && !helperObserved) throw new OrphanCloseRefusal('lsof did not cover the attested purge helper');
}
