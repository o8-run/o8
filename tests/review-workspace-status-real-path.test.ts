import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/review/workspace/route';
import { invalidateReviewSnapshotCache } from '@/lib/review/workspace';

let folder: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, encoding: 'utf8', stdio: 'pipe' });
const read = (workspace = folder) => GET(new Request(`http://localhost/api/review/workspace?changesOnly=1&workspace=${encodeURIComponent(workspace)}`));
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'o8-review-status-')); invalidateReviewSnapshotCache(); });
afterEach(() => { vi.unstubAllEnvs(); invalidateReviewSnapshotCache(); rmSync(folder, { recursive: true, force: true }); });

describe('workspace review status through the route', () => {
  it('distinguishes non-Git and missing folders without claiming a clean review', async () => {
    const response = await read();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'REVIEW_NOT_GIT', error: expect.stringContaining('Git repository') });
    const missing = await read(join(folder, 'missing'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'REVIEW_PATH_MISSING' });
  });

  it('preserves clean, untracked and staged changes before the first commit without a remote', async () => {
    git('init', '-q');
    expect(await (await read()).json()).toMatchObject({ dirty: false, changedFiles: [] });
    writeFileSync(join(folder, 'sample.txt'), 'first\n');
    invalidateReviewSnapshotCache();
    expect(await (await read()).json()).toMatchObject({ dirty: true, changedFiles: [expect.objectContaining({ path: 'sample.txt', status: 'untracked' })] });
    git('add', 'sample.txt');
    invalidateReviewSnapshotCache();
    expect(await (await read()).json()).toMatchObject({ dirty: true, changedFiles: [expect.objectContaining({ path: 'sample.txt', status: 'added', staged: true })] });
  });

  it('evicts older review snapshots when distinct workspaces fill the cache', async () => {
    git('init', '-q');
    const readVariant = (index: number) => GET(new Request(
      `http://localhost/api/review/workspace?workspace=${encodeURIComponent(folder)}&changesOnly=1&repo=fixture/workspace-${index}`,
    ));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      expect(await (await readVariant(0)).json()).toMatchObject({ dirty: false });
      writeFileSync(join(folder, 'new.txt'), 'new\n');
      for (let index = 1; index <= 16; index += 1) {
        expect((await readVariant(index)).status).toBe(200);
      }
      expect(await (await readVariant(0)).json()).toMatchObject({
        dirty: true,
        changedFiles: [expect.objectContaining({ path: 'new.txt' })],
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('includes intent-to-add and later unstaged edits before the first commit', async () => {
    git('init', '-q');
    writeFileSync(join(folder, 'intent.txt'), 'working content\n'); git('add', '-N', 'intent.txt');
    expect(await (await read()).json()).toMatchObject({ dirty: true, changedFiles: [expect.objectContaining({ path: 'intent.txt', additions: 1 })] });
    git('add', 'intent.txt'); writeFileSync(join(folder, 'intent.txt'), 'working content\nsecond line\n');
    invalidateReviewSnapshotCache();
    expect(await (await read()).json()).toMatchObject({ dirty: true, changedFiles: [expect.objectContaining({ path: 'intent.txt', additions: 2 })] });
  });

  it('handles clean and dirty committed repositories with and without an origin', async () => {
    git('init', '-q');
    writeFileSync(join(folder, 'sample.txt'), 'first\n'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
    for (const remote of [false, true]) {
      if (remote) git('remote', 'add', 'origin', 'https://github.com/example/sample.git');
      writeFileSync(join(folder, 'sample.txt'), 'first\n'); invalidateReviewSnapshotCache();
      expect(await (await read()).json()).toMatchObject({ dirty: false, changedFiles: [] });
      writeFileSync(join(folder, 'sample.txt'), 'changed\n'); invalidateReviewSnapshotCache();
      expect(await (await read()).json()).toMatchObject({ dirty: true, changedFiles: [expect.objectContaining({ path: 'sample.txt', status: 'modified' })] });
    }
  });

  it('does not treat an unavailable Git executable as an empty diff', async () => {
    git('init', '-q');
    const emptyPath = join(folder, 'bin'); mkdirSync(emptyPath); vi.stubEnv('PATH', emptyPath);
    const response = await read(); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'REVIEW_GIT_UNAVAILABLE' });
  });

  it.skipIf(process.platform === 'win32').each(['status', 'diff'])('reports a failed %s command after repository detection succeeds', async (command) => {
    git('init', '-q');
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(folder, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nif (process.argv[2] === ${JSON.stringify(command)}) process.exit(43);\nconst child = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exit(child.status ?? 1);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', bin);
    const response = await read(); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'REVIEW_GIT_UNAVAILABLE' });
  });

  it('does not treat failed status or diff commands as clean', async () => {
    git('init', '-q');
    // Real invalid Git configuration makes local probes fail before a snapshot is returned.
    writeFileSync(join(folder, '.git', 'config'), 'invalid config [');
    const response = await read(); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'REVIEW_GIT_UNAVAILABLE' });
  });
});
