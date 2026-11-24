import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { controlComputerJob, undoComputerJobAction } from './computer-job-control';
import { CRON_DISABLED_MARKER, type ComputerJobsDeps } from './computer-jobs';

const BACKUP = '0 2 * * * /usr/local/bin/backup --pass hidden';

function deps(state: { crontab: string; changes: string[][] }): ComputerJobsDeps {
  const root = mkdtempSync(join(tmpdir(), 'o8-job-control-unit-'));
  const plists: Record<string, object> = {
    '/home/Library/LaunchAgents/ai.o8.bench.plist': { Label: 'ai.o8.bench', Program: '/bin/sh', StartInterval: 60 },
    '/Library/LaunchDaemons/com.example.daemon.plist': { Label: 'com.example.daemon', Program: '/Library/Example/daemon', KeepAlive: true },
  };
  return {
    run: async (command, args) => {
      if (command === 'crontab') return state.crontab;
      if (command === 'plutil') return JSON.stringify(plists[args.at(-1)!] ?? null);
      if (command === 'launchctl' && args[1] === 'gui/501') return '\tservices = {\n\t\t     0      - \tai.o8.bench\n\t}\n';
      if (command === 'launchctl' && args[1] === 'system') return '\tservices = {\n\t\t     7      - \tcom.example.daemon\n\t}\n';
      return null;
    },
    change: async (command, args) => {
      state.changes.push([command, ...args]);
      if (command === 'crontab') state.crontab = readFileSync(args[0]!, 'utf8');
    },
    logPath: join(root, 'scheduled-job-actions.jsonl'),
    listDir: async (path) => Object.keys(plists).filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1)),
    home: '/home', uid: 501, platform: 'darwin', now: () => 1_000,
  };
}

describe('changing a job on this Mac', () => {
  it('disables a crontab line by commenting it out, keeps the line, and undoes it', async () => {
    const state = { crontab: `MAILTO=""\n${BACKUP}\n@daily /bin/sync\n`, changes: [] as string[][] };
    const d = deps(state);
    const { readComputerJobs } = await import('./computer-jobs');
    const row = (await readComputerJobs(d)).jobs.find((job) => job.label === 'backup')!;
    expect(row.actions).toEqual(['disable']);

    const result = await controlComputerJob({ id: row.id, action: 'disable', confirm: 'backup' }, d);
    expect(result.ok).toBe(true);
    expect(state.crontab).toBe(`MAILTO=""\n${CRON_DISABLED_MARKER}${BACKUP}\n@daily /bin/sync\n`);
    if (!result.ok) return;
    expect(result.job).toMatchObject({ disabled: true, actions: [], undoEntryId: result.entry.entryId });

    expect((await undoComputerJobAction(result.entry.entryId, d)).ok).toBe(true);
    expect(state.crontab).toBe(`MAILTO=""\n${BACKUP}\n@daily /bin/sync\n`);
    // The command's arguments are never written to the log.
    expect(readFileSync(d.logPath, 'utf8')).not.toContain('--pass');
  });

  it("refuses system jobs and o8's own jobs and a confirmation that does not name the job, running nothing", async () => {
    const state = { crontab: `${BACKUP}\n`, changes: [] as string[][] };
    const d = deps(state);
    expect(await controlComputerJob({ id: 'user:com.example.daemon', action: 'stop', confirm: 'com.example.daemon' }, d))
      .toMatchObject({ ok: false, status: 404 });
    const { readComputerJobs } = await import('./computer-jobs');
    const jobs = (await readComputerJobs(d)).jobs;
    const daemon = jobs.find((job) => job.label === 'com.example.daemon')!;
    expect(await controlComputerJob({ id: daemon.id, action: 'stop', confirm: daemon.label }, d))
      .toMatchObject({ ok: false, status: 422, error: expect.stringContaining('System job') });
    expect(await controlComputerJob({ id: 'user:ai.o8.bench', action: 'disable', confirm: 'ai.o8.bench' }, d))
      .toMatchObject({ ok: false, status: 422, error: expect.stringContaining("o8's own") });
    const backup = jobs.find((job) => job.label === 'backup')!;
    expect(await controlComputerJob({ id: backup.id, action: 'disable', confirm: 'something else' }, d))
      .toMatchObject({ ok: false, status: 409, confirm: { label: 'backup', program: '/usr/local/bin/backup' } });
    expect(state.changes).toEqual([]);
  });
});
