/**
 * Stop or disable a job on this Mac, with an undo kept in a log.
 *
 * Only the user's own launchd domain and crontab: system agents and daemons
 * stay read-only, and o8's own jobs are changed through o8's own controls.
 * A plist file or crontab line is never deleted: stop is `launchctl bootout`
 * for this login, disable is `launchctl disable` (or a commented crontab
 * line), and each has an undo. The job is found again on this machine by id;
 * a label from the client is only the confirmation that names it.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CRON_DISABLED_MARKER,
  crontabLineId,
  defaultComputerJobsDeps,
  readComputerJobs,
  readComputerJobsLog,
  type ComputerJob,
  type ComputerJobAction,
  type ComputerJobLogEntry,
  type ComputerJobsDeps,
} from './computer-jobs';

export type ControlResult =
  | { ok: true; entry: ComputerJobLogEntry; job: ComputerJob | null }
  | { ok: false; status: 404 | 409 | 422 | 502; error: string; confirm?: { label: string; program: string | null; action: string; effect: string } };


const EFFECT: Record<ComputerJobAction, string> = {
  stop: 'Stops it for this login. It starts again at the next login unless it is disabled.',
  disable: 'Keeps launchd from starting it, across logins, until it is enabled again.',
};
const CRON_EFFECT = 'Comments out its crontab line so cron skips it. The line stays in the crontab.';

function appendLog(path: string, entry: ComputerJobLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Replaces one crontab line, matched by its id, and installs the result. Nothing is removed. */
async function rewriteCrontab(deps: ComputerJobsDeps, match: (line: string) => boolean, replace: (line: string) => string): Promise<string | null> {
  const table = await deps.run('crontab', ['-l']);
  if (table === null) return null;
  const lines = table.split('\n');
  const index = lines.findIndex((line) => match(line));
  if (index < 0) return null;
  const before = lines[index]!;
  lines[index] = replace(before);
  const folder = mkdtempSync(join(dirname(deps.logPath), 'crontab-'));
  try {
    const file = join(folder, 'crontab');
    writeFileSync(file, lines.join('\n'), { mode: 0o600 });
    await deps.change('crontab', [file]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return before;
}

export async function controlComputerJob(input: { id: string; action: ComputerJobAction; confirm: string },
  deps: ComputerJobsDeps = defaultComputerJobsDeps()): Promise<ControlResult> {
  const job = (await readComputerJobs(deps)).jobs.find((candidate) => candidate.id === input.id);
  if (!job) return { ok: false, status: 404, error: 'That job is no longer on this Mac.' };
  if (!job.actions.includes(input.action)) {
    return { ok: false, status: 422, error: job.readOnlyReason ?? `This job cannot be ${input.action === 'stop' ? 'stopped' : 'disabled'} here.` };
  }
  if (input.confirm !== job.label) {
    return { ok: false, status: 409, error: 'Confirm by naming the job.', confirm: {
      label: job.label, program: job.program, action: input.action,
      effect: job.scope === 'cron' ? CRON_EFFECT : EFFECT[input.action],
    } };
  }
  const base = { entryId: randomUUID(), at: deps.now(), jobId: job.id, label: job.label, scope: job.scope, program: job.program, action: input.action };
  let entry: ComputerJobLogEntry;
  try {
    if (job.scope === 'cron') {
      const id = job.id;
      const before = await rewriteCrontab(deps, (line) => crontabLineId(line.trim()) === id,
        (line) => `${CRON_DISABLED_MARKER}${line}`);
      if (before === null) return { ok: false, status: 404, error: 'That crontab line changed; read the list again.' };
      // The log keeps the line's hash, never its text: a command can hold secrets.
      entry = { ...base, undo: { crontabLineId: id } };
    } else {
      const service = `gui/${deps.uid}/${job.label}`;
      if (input.action === 'stop') {
        await deps.change('launchctl', ['bootout', service]);
        entry = { ...base, undo: { command: 'launchctl', args: ['bootstrap', `gui/${deps.uid}`, job.plist!] } };
      } else {
        await deps.change('launchctl', ['disable', service]);
        entry = { ...base, undo: { command: 'launchctl', args: ['enable', service] } };
      }
    }
  } catch {
    return { ok: false, status: 502, error: `launchd refused to ${input.action} ${job.label}.` };
  }
  appendLog(deps.logPath, entry);
  const after = (await readComputerJobs(deps)).jobs.find((candidate) => candidate.label === job.label && candidate.scope === job.scope) ?? null;
  return { ok: true, entry, job: after };
}

/** Reverses one logged stop or disable, once. */
export async function undoComputerJobAction(entryId: string, deps: ComputerJobsDeps = defaultComputerJobsDeps()): Promise<ControlResult> {
  const log = readComputerJobsLog(deps.logPath);
  const entry = log.find((candidate) => candidate.entryId === entryId && candidate.action !== 'undo');
  if (!entry?.undo) return { ok: false, status: 404, error: 'Nothing to undo for that entry.' };
  if (log.some((candidate) => candidate.undoes === entryId)) return { ok: false, status: 409, error: 'That change was already undone.' };
  try {
    if ('crontabLineId' in entry.undo) {
      const lineId = entry.undo.crontabLineId;
      const restored = await rewriteCrontab(deps,
        (line) => line.startsWith(CRON_DISABLED_MARKER) && crontabLineId(line.slice(CRON_DISABLED_MARKER.length).trim()) === lineId,
        (line) => line.slice(CRON_DISABLED_MARKER.length));
      if (restored === null) return { ok: false, status: 404, error: 'The disabled crontab line is no longer there.' };
    } else {
      await deps.change(entry.undo.command, entry.undo.args);
    }
  } catch {
    return { ok: false, status: 502, error: `launchd refused to undo the change to ${entry.label}.` };
  }
  const undo: ComputerJobLogEntry = {
    entryId: randomUUID(), at: deps.now(), jobId: entry.jobId, label: entry.label, scope: entry.scope,
    program: entry.program, action: 'undo', undoes: entry.entryId,
  };
  appendLog(deps.logPath, undo);
  const job = (await readComputerJobs(deps)).jobs.find((candidate) => candidate.label === entry.label && candidate.scope === entry.scope) ?? null;
  return { ok: true, entry: undo, job };
}
