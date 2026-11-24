import { describe, expect, it } from 'vitest';

import {
  crontabJobs,
  jobMaker,
  parseDomainPrint,
  parseServicePrint,
  plistTriggers,
  readComputerJobs,
  type ComputerJobsDeps,
} from './computer-jobs';

const SECRET = 'sk-hidden-value';
const HOME = '/Users/fixture';

const userDomain = `gui/501 = {
\ttype = login
\tservices = {
\t\t     812      0 \tcom.example.syncer
\t\t       0     78 \tcom.example.nightly
\t\t       0      - \tcom.apple.ignored
\t\t     930      - \tcom.example.helper
\t\t     931      - \tapplication.com.example.Editor.1.2
\t}
\tdisabled services = {
\t\t"com.example.nightly" => disabled
\t\t"com.example.syncer" => enabled
\t}
}
`;

const systemDomain = `system = {
\tservices = {
\t\t     101      - \tcom.example.daemon
\t}
}
`;

function service(state: string, extra = ''): string {
  return `x = {
\tstate = ${state}
\tprogram = /Applications/Example.app/Contents/MacOS/helper
\targuments = {
\t\t/Applications/Example.app/Contents/MacOS/helper
\t\t--token=${SECRET}
\t}
\tenvironment = {
\t\tTOKEN => ${SECRET}
\t}
\truns = 14
${extra}\tlast exit code = 0
}
`;
}

const plists: Record<string, object> = {
  [`${HOME}/Library/LaunchAgents/com.example.syncer.plist`]: {
    Label: 'com.example.syncer', ProgramArguments: ['/opt/tools/bin/syncer', `--key=${SECRET}`],
    EnvironmentVariables: { TOKEN: SECRET }, KeepAlive: true, RunAtLoad: true,
  },
  [`${HOME}/Library/LaunchAgents/com.example.nightly.plist`]: {
    Label: 'com.example.nightly', Program: `${HOME}/jobs/nightly.sh`, StartCalendarInterval: { Hour: 2, Minute: 43 },
  },
  [`${HOME}/Library/LaunchAgents/ai.o8.bench.plist`]: {
    Label: 'ai.o8.bench', ProgramArguments: ['/bin/sh', '-c', `TOKEN=${SECRET} run`], StartInterval: 300,
  },
  '/Library/LaunchAgents/com.example.agent.plist': {
    Label: 'com.example.agent', BundleProgram: 'Contents/MacOS/agent', AssociatedBundleIdentifiers: ['com.example.app'],
    WatchPaths: ['/tmp/a', '/tmp/b'],
  },
  '/Library/LaunchDaemons/com.example.daemon.plist': {
    Label: 'com.example.daemon', Program: '/Library/Example/daemon', KeepAlive: { SuccessfulExit: false },
  },
};

function deps(calls: string[][] = []): ComputerJobsDeps {
  return {
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'crontab') return `PATH=/bin\n*/15 * * * * API_KEY=${SECRET} /usr/local/bin/backup --pass ${SECRET}\n`;
      if (command === 'plutil') return JSON.stringify(plists[args.at(-1)!] ?? null);
      if (command !== 'launchctl') return null;
      const target = args[1]!;
      if (target === 'gui/501') return userDomain;
      if (target === 'system') return systemDomain;
      if (target === 'gui/501/com.example.syncer') return service('running', '\tpid = 812\n');
      if (target === 'gui/501/com.example.helper') return service('running', '\tpid = 930\n\tparent bundle identifier = com.example.app\n');
      if (target === 'gui/501/com.example.nightly') return service('not running').replace('last exit code = 0', 'last exit code = 78');
      if (target === 'system/com.example.daemon') return service('running', '\tpid = 101\n').replace('runs = 14', 'runs = 1');
      return null;
    },
    change: async () => { throw new Error('the read path never changes anything'); },
    logPath: '/nonexistent/scheduled-job-actions.jsonl',
    listDir: async (path) => Object.keys(plists).filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1)),
    home: HOME,
    uid: 501,
    platform: 'darwin',
    now: () => 1_000,
  };
}

describe('everything scheduled on this Mac', () => {
  it('lists user, system and crontab jobs, running first, then the most frequent', async () => {
    const calls: string[][] = [];
    const report = await readComputerJobs(deps(calls));
    expect(report.jobs.map((job) => [job.label, job.scope, job.running, job.pid])).toEqual([
      ['com.example.syncer', 'user', true, 812],
      ['com.example.daemon', 'system-daemon', true, 101],
      ['com.example.helper', 'user', true, 930],
      ['ai.o8.bench', 'user', false, null],
      ['backup', 'cron', false, null],
      ['com.example.nightly', 'user', false, null],
      ['com.example.agent', 'system-agent', false, null],
    ]);
    expect(report.hiddenMacosJobs).toBe(1);
    expect(report.hiddenOpenApps).toBe(1);
    expect(report.loginItems.readable).toBe(false);

    const byLabel = Object.fromEntries(report.jobs.map((job) => [job.label, job]));
    expect(byLabel['com.example.syncer']).toMatchObject({
      program: '/opt/tools/bin/syncer', triggers: ['keep alive', 'run at load'], loaded: true, runs: 14, lastExit: '0',
      disabled: false, maker: { kind: 'user', name: '/opt/tools/bin' },
    });
    expect(byLabel['com.example.nightly']).toMatchObject({
      triggers: ['at 02:43'], runsPerDay: 1, loaded: true, lastExit: '78', disabled: true, maker: { kind: 'user', name: '~/jobs' },
    });
    expect(byLabel['ai.o8.bench']).toMatchObject({ program: '/bin/sh', triggers: ['every 5 min'], runsPerDay: 288, loaded: false, maker: { kind: 'o8' } });
    expect(byLabel['com.example.agent']).toMatchObject({ triggers: ['watch paths (2)'], runsPerDay: null, maker: { kind: 'app', name: 'com.example.app' } });
    expect(byLabel['com.example.daemon']).toMatchObject({ triggers: ['keep alive (conditional)'], maker: { kind: 'system', name: '/Library/Example' } });
    expect(byLabel['com.example.helper']).toMatchObject({ plist: null, triggers: ['registered by an app'], maker: { kind: 'app', name: 'Example' } });
    expect(byLabel.backup).toMatchObject({ program: '/usr/local/bin/backup', triggers: ['cron */15 * * * *'], runsPerDay: 96, maker: { kind: 'user', name: 'crontab' } });

    // Only the user's own jobs can be changed, and o8's own go through o8.
    expect(byLabel['com.example.syncer']).toMatchObject({ actions: ['stop', 'disable'], readOnlyReason: null, undoEntryId: null });
    expect(byLabel['com.example.nightly']).toMatchObject({ actions: ['stop'] });
    expect(byLabel['com.example.helper']).toMatchObject({ actions: ['disable'] });
    expect(byLabel['ai.o8.bench']!.actions).toEqual([]);
    expect(byLabel['ai.o8.bench']!.readOnlyReason).toContain("o8's own");
    expect(byLabel['com.example.daemon']!.actions).toEqual([]);
    expect(byLabel['com.example.agent']!.readOnlyReason).toContain('System job');
    expect(byLabel.backup).toMatchObject({ actions: ['disable'] });

    // Arguments and environment values never leave the collector.
    expect(JSON.stringify(report)).not.toContain(SECRET);
    // Read-only commands only.
    for (const call of calls) {
      expect(call[0] === 'launchctl' ? call[1] : call[0] === 'plutil' ? call[1] : call.slice(1).join(' ')).toMatch(/^(print|-convert|-l)$/);
    }
  });

  it('reads the launchctl tables it depends on', () => {
    const user = parseDomainPrint(userDomain);
    expect(user.services.get('com.example.syncer')).toEqual({ pid: 812, lastExit: '0' });
    expect(user.services.get('com.example.helper')).toEqual({ pid: 930, lastExit: null });
    expect(user.disabled.get('com.example.nightly')).toBe(true);
    expect(user.disabled.get('com.example.syncer')).toBe(false);
    expect(parseServicePrint(service('running', '\tpid = 9\n'))).toEqual({
      running: true, pid: 9, runs: 14, lastExit: '0',
      program: '/Applications/Example.app/Contents/MacOS/helper', parentBundle: null,
    });
  });

  it('reads triggers and makers from plain launchd and cron fields', () => {
    expect(plistTriggers({ StartCalendarInterval: [{ Hour: 1 }, { Minute: 5 }] })).toEqual({ triggers: ['2 calendar times'], runsPerDay: 60 + 24 });
    expect(plistTriggers({ RunAtLoad: true })).toEqual({ triggers: ['run at load'], runsPerDay: 0 });
    expect(jobMaker({ label: 'x', program: `${HOME}/.o8/bin/o8`, scope: 'user', home: HOME })).toEqual({ kind: 'o8', name: 'o8' });
    expect(jobMaker({ label: 'x', program: null, scope: 'system-daemon', home: HOME })).toEqual({ kind: 'system', name: 'installed for all users' });
    expect(crontabJobs('@daily /bin/sync hidden\n# note\n').map((job) => [job.label, job.triggers, job.runsPerDay]))
      .toEqual([['sync', ['@daily'], 1]]);
  });

  it('reads only the crontab off macOS', async () => {
    const calls: string[][] = [];
    const report = await readComputerJobs({ ...deps(calls), platform: 'linux' });
    expect(report.jobs.map((job) => job.label)).toEqual(['backup']);
    expect(calls).toEqual([['crontab', '-l']]);
  });
});
