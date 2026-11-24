import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { controlComputerJob, undoComputerJobAction } from '@/lib/automations/computer-job-control';
import { defaultComputerJobsDeps, readComputerJobs } from '@/lib/automations/computer-jobs';

// A throwaway agent this test creates in the user's launchd domain and removes
// at the end. No real job on the machine is touched.
const LABEL = 'local.o8-test.throwaway';
const darwin = process.platform === 'darwin' && typeof process.getuid === 'function';
const uid = darwin ? process.getuid!() : 0;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-job-control-')));
const home = join(root, 'home');
const plist = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

const launchctl = (...args: string[]) => {
  try { return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const loaded = () => launchctl('print', `gui/${uid}/${LABEL}`) !== null;
const disabled = () => new RegExp(`"${LABEL.replace(/\./g, '\\.')}" => (?:disabled|true)`).test(launchctl('print-disabled', `gui/${uid}`) ?? '');

afterAll(() => {
  if (darwin) {
    launchctl('bootout', `gui/${uid}/${LABEL}`);
    launchctl('enable', `gui/${uid}/${LABEL}`);
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!darwin)('stopping and disabling a user launch agent', () => {
  it('asks for the job by name, stops and disables it, and undoes each from the log', async () => {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`);
    expect(launchctl('bootstrap', `gui/${uid}`, plist)).not.toBeNull();
    expect(loaded()).toBe(true);
    const deps = { ...defaultComputerJobsDeps(), home, logPath: join(root, 'data', 'scheduled-job-actions.jsonl') };
    mkdirSync(join(root, 'data'));
    const id = `user:${LABEL}`;
    const job = (await readComputerJobs(deps)).jobs.find((row) => row.id === id);
    expect(job).toMatchObject({ program: '/bin/sleep', plist, actions: ['stop', 'disable'], undoEntryId: null });

    // Without the job's name nothing runs; the reply says what would.
    const unconfirmed = await controlComputerJob({ id, action: 'stop', confirm: '' }, deps);
    expect(unconfirmed).toMatchObject({ ok: false, status: 409, confirm: { label: LABEL, program: '/bin/sleep', action: 'stop' } });
    expect(loaded()).toBe(true);

    const stopped = await controlComputerJob({ id, action: 'stop', confirm: LABEL }, deps);
    expect(stopped.ok).toBe(true);
    expect(loaded()).toBe(false);
    if (!stopped.ok) return;
    expect(stopped.job).toMatchObject({ loaded: false, undoEntryId: stopped.entry.entryId });
    expect(readFileSync(plist, 'utf8')).toContain(LABEL);
    const restarted = await undoComputerJobAction(stopped.entry.entryId, deps);
    expect(restarted.ok).toBe(true);
    expect(loaded()).toBe(true);
    expect(await undoComputerJobAction(stopped.entry.entryId, deps)).toMatchObject({ ok: false, status: 409 });

    const off = await controlComputerJob({ id, action: 'disable', confirm: LABEL }, deps);
    expect(off.ok).toBe(true);
    expect(disabled()).toBe(true);
    if (!off.ok) return;
    expect((await undoComputerJobAction(off.entry.entryId, deps)).ok).toBe(true);
    expect(disabled()).toBe(false);

    const log = readFileSync(deps.logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(log.map((entry) => entry.action)).toEqual(['stop', 'undo', 'disable', 'undo']);
    expect(JSON.stringify(log)).not.toContain('600');
  }, 60_000);
});
