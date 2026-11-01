import { describe, expect, it } from 'vitest';
import { codexJob, cronJobs, launchctlCommands, launchdDetail, launchdJob, launchdTitle, nextCalendarRun, parseLaunchctlList, rruleLabel } from './local-schedules';

describe('local schedule discovery', () => {
  it('reads launchd timing and never returns the command or environment', () => {
    const row = launchdJob({ Label: 'com.example.nightly', StartCalendarInterval: { Hour: 2, Minute: 43 },
      ProgramArguments: ['/bin/run', '--token=hidden'], EnvironmentVariables: { TOKEN: 'hidden' } } as never, new Set());
    expect(row).toMatchObject({ name: 'Nightly', source: 'com.example.nightly', agentId: 'launchd', enabled: true, readOnly: false,
      schedule: { kind: 'cron', expr: '43 2 * * *' } });
    expect(JSON.stringify(row)).not.toContain('hidden');
  });

  it('skips launchd jobs with no timing and marks disabled ones', () => {
    expect(launchdJob({ Label: 'com.example.daemon' }, new Set())).toBeNull();
    expect(launchdJob({ Label: 'com.example.interval', StartInterval: 900 }, new Set(['com.example.interval'])))
      .toMatchObject({ enabled: false, schedule: { kind: 'every', everyMs: 900_000 } });
  });

  it('says what a job does without its arguments or path', () => {
    expect(launchdTitle('com.o8.bookmarks-daily')).toBe('Bookmarks daily');
    expect(launchdDetail({ ProgramArguments: ['/bin/bash', '/Users/me/jobs/bookmarks/run.sh', '--token=hidden'] })).toBe('Runs bookmarks/run.sh');
    expect(launchdDetail({ ProgramArguments: ['/usr/bin/python3', '-u', '/srv/scout.py'] })).toBe('Runs scout.py');
    expect(launchdDetail({ ProgramArguments: ['/bin/sh', '-c', 'TOKEN=hidden run'] })).toBeNull();
  });

  it('reads running and failed state from launchctl', () => {
    const states = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.a.up\n-\t78\tcom.a.bad\n');
    const bad = launchdJob({ Label: 'com.a.bad', StartInterval: 60 }, new Set(), states, 1000, 2000);
    expect(bad).toMatchObject({ enabled: true, lastRunStatus: 'failed', lastExitCode: 78 });
    expect(launchdJob({ Label: 'com.a.up', StartInterval: 60 }, new Set(), states)).toMatchObject({ lastRunStatus: 'running' });
    expect(launchdJob({ Label: 'com.a.gone', StartInterval: 60 }, new Set(), states)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('finds the next calendar time', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime();
    expect(new Date(nextCalendarRun({ Hour: 2, Minute: 43 }, now)!).getDate()).toBe(3);
    expect(new Date(nextCalendarRun({ Hour: 13, Minute: 0 }, now)!).getHours()).toBe(13);
    expect(new Date(nextCalendarRun({ Minute: 10 }, now)!).getMinutes()).toBe(10);
  });

  it('pauses so a job stays off after a restart', () => {
    expect(launchctlCommands('run', 501, 'com.a', '/p')).toEqual([['kickstart', 'gui/501/com.a']]);
    expect(launchctlCommands('pause', 501, 'com.a', '/p')).toEqual([['disable', 'gui/501/com.a'], ['bootout', 'gui/501', '/p']]);
    expect(launchctlCommands('resume', 501, 'com.a', '/p')).toEqual([['enable', 'gui/501/com.a'], ['bootstrap', 'gui/501', '/p']]);
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
    expect(rruleLabel('FREQ=MINUTELY;INTERVAL=15')).toBe('Every 15 minutes');
    expect(rruleLabel('RRULE:FREQ=HOURLY;INTERVAL=1')).toBe('Every hour');
    expect(rruleLabel('FREQ=DAILY;BYHOUR=3;BYMINUTE=10;BYSECOND=0')).toBe('Daily at 03:10');
  });
});
