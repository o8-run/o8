import { describe, expect, it } from 'vitest';
import { codexJob, cronJobs, launchdJob, rruleLabel } from './local-schedules';

describe('local schedule discovery', () => {
  it('reads launchd timing and never returns the command or environment', () => {
    const row = launchdJob({ Label: 'com.example.nightly', StartCalendarInterval: { Hour: 2, Minute: 43 },
      ProgramArguments: ['/bin/run', '--token=hidden'], EnvironmentVariables: { TOKEN: 'hidden' } } as never, new Set());
    expect(row).toMatchObject({ name: 'com.example.nightly', agentId: 'launchd', enabled: true, readOnly: true,
      schedule: { kind: 'cron', expr: '43 2 * * *' } });
    expect(JSON.stringify(row)).not.toContain('hidden');
  });

  it('skips launchd jobs with no timing and marks disabled ones', () => {
    expect(launchdJob({ Label: 'com.example.daemon' }, new Set())).toBeNull();
    expect(launchdJob({ Label: 'com.example.interval', StartInterval: 900 }, new Set(['com.example.interval'])))
      .toMatchObject({ enabled: false, schedule: { kind: 'every', everyMs: 900_000 } });
  });

  it('names cron rows by program and drops arguments, comments and env lines', () => {
    const rows = cronJobs('# note\nPATH=/bin\n0 2 * * * /usr/local/bin/backup --key hidden\n@daily /bin/sync hidden\n');
    expect(rows.map(row => row.name)).toEqual(['backup', 'sync']);
    expect(rows[0]!.schedule).toMatchObject({ kind: 'cron', expr: '0 2 * * *' });
    expect(rows[1]!.schedule.label).toBe('@daily');
    expect(JSON.stringify(rows)).not.toContain('hidden');
  });

  it('reads Codex automations without the prompt', () => {
    const row = codexJob('check', 'name = "Check it"\nstatus = "PAUSED"\nrrule = "RRULE:FREQ=DAILY;BYHOUR=14;BYMINUTE=12"\nprompt = "hidden"\n');
    expect(row).toMatchObject({ name: 'Check it', agentId: 'codex', enabled: false, schedule: { label: 'Daily at 14:12' } });
    expect(JSON.stringify(row)).not.toContain('hidden');
    expect(rruleLabel(null)).toBeNull();
  });
});
