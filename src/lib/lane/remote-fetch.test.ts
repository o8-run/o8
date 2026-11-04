import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWorkerBranch } from './remote-fetch';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalAllow = process.env.O8_WORKER_ENV_ALLOW;

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.O8_REMOTE_FETCH_ARGV_LOG;
  if (originalAllow === undefined) delete process.env.O8_WORKER_ENV_ALLOW;
  else process.env.O8_WORKER_ENV_ALLOW = originalAllow;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fetchWorkerBranch option termination', () => {
  it('passes a dash-prefixed branch after git fetch --end-of-options', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'o8-remote-fetch-argv-'));
    tempDirs.push(root);
    const fakeBin = join(root, 'bin');
    const fakeGit = join(fakeBin, 'git');
    const argvLog = join(root, 'argv.log');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$O8_REMOTE_FETCH_ARGV_LOG"\nif [ "$1" = "rev-parse" ]; then printf '%s\\n' deadbeef; fi\n`);
    chmodSync(fakeGit, 0o755);
    process.env.O8_REMOTE_FETCH_ARGV_LOG = argvLog;
    // Children inherit only allowlisted names (#4585); pass the fake git its log path.
    process.env.O8_WORKER_ENV_ALLOW = 'O8_REMOTE_FETCH_ARGV_LOG';
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`;

    const branch = '--upload-pack=attacker-command';
    const result = await fetchWorkerBranch(root, branch, 'dash-branch');

    expect(result.ok).toBe(true);
    const invocations = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(invocations).toContain(`fetch --end-of-options origin ${branch}`);
    expect(invocations.some((line) => line === `fetch origin ${branch}`)).toBe(false);
  });
});
