import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveGitBinary } from '@/lib/git/binary';
import { createDetachedIntegrationWorktree } from '@/lib/lane/worktree-merge-git';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';
import { requireBwrap } from '@/lib/runtimes/shared/owned-session/sandbox-linux';

// o8 merges a lane in a clone it makes for the merge and runs Git there
// outside the sandbox. A sandboxed worker, its own lane's or another's, must
// not be able to change that clone's Git configuration or hooks.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-integration-clone-')));
const dataDir = join(root, 'data');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gitBinary = resolveGitBinary();
const git = (cwd: string, ...args: string[]) => execFileSync(gitBinary, ['-c', 'user.name=o8 test',
  '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const WORKER_STEPS = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [gitDir] = process.argv.slice(1);
const result = {};
const step = (name, run) => { try { run(); result[name] = 'allowed'; } catch { result[name] = 'refused'; } };
step('editConfig', () => fs.appendFileSync(path.join(gitDir, 'config'), '[core]\n\tfsmonitor = /worker\n'));
step('addHook', () => fs.writeFileSync(path.join(gitDir, 'hooks', 'post-rewrite'), '#!/bin/sh\n'));
process.stdout.write(JSON.stringify(result));
`;

const sandboxUsable = process.platform === 'darwin'
  ? existsSync('/usr/bin/sandbox-exec')
  : process.platform === 'linux' && await requireBwrap().then(() => true, () => false);

function laneRepository(name: string) {
  const repo = join(root, `${name}-repo`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const lane = join(root, `${name}-lane`);
  git(repo, 'worktree', 'add', '-q', '-b', `inline/pkt-${name}`, lane, 'main');
  writeFileSync(join(lane, 'work.txt'), 'worker\n');
  git(lane, 'add', '-A');
  git(lane, 'commit', '-qm', 'lane work');
  return { repo, lane, sha: git(lane, 'rev-parse', 'HEAD') };
}

describe('merge integration clones', () => {
  it('leave nothing behind, and a clone abandoned for a day is removed by the next merge', async () => {
    const { repo, lane, sha } = laneRepository('cleanup');
    const merges = join(dataDir, 'lane-merge');
    mkdirSync(join(merges, 'integration-abandoned'), { recursive: true });
    mkdirSync(join(merges, 'integration-recent'), { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(join(merges, 'integration-abandoned'), twoDaysAgo, twoDaysAgo);

    const integration = await createDetachedIntegrationWorktree({ repoPath: repo, sourceWorktreePath: lane, sourceSha: sha });
    expect(git(integration.path, 'rev-parse', 'HEAD')).toBe(sha);
    await integration.cleanup();
    expect(readdirSync(merges).sort()).toEqual(['integration-recent']);
  });

  it('keep merging when an abandoned clone cannot be removed', async () => {
    const { repo, lane, sha } = laneRepository('stuck');
    const stuck = join(dataDir, 'lane-merge', 'integration-stuck');
    mkdirSync(join(stuck, 'locked'), { recursive: true });
    writeFileSync(join(stuck, 'locked', 'file'), 'leftover\n');
    chmodSync(join(stuck, 'locked'), 0o555);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(stuck, twoDaysAgo, twoDaysAgo);
    try {
      const integration = await createDetachedIntegrationWorktree({ repoPath: repo, sourceWorktreePath: lane, sourceSha: sha });
      expect(git(integration.path, 'rev-parse', 'HEAD')).toBe(sha);
      await integration.cleanup();
    } finally {
      chmodSync(join(stuck, 'locked'), 0o755);
      rmSync(stuck, { recursive: true, force: true });
    }
  });
});

describe.runIf(sandboxUsable)('the merge integration clone under the production worker sandbox', () => {
  it("keeps a worker out of the clone's Git directory", async () => {
    const { repo, lane, sha } = laneRepository('merge');
    const integration = await createDetachedIntegrationWorktree({ repoPath: repo, sourceWorktreePath: lane, sourceSha: sha });
    try {
      const gitDir = git(integration.path, 'rev-parse', '--path-format=absolute', '--git-dir');
      mkdirSync(join(gitDir, 'hooks'), { recursive: true });
      const config = readFileSync(join(gitDir, 'config'), 'utf8');

      // Launched as the lane runtimes launch it: no TMPDIR of its own.
      const home = join(root, 'home');
      const profiles = join(root, 'profiles');
      for (const dir of [home, profiles]) mkdirSync(dir, { recursive: true });
      const prepared = await prepareWorkerSandbox({
        runId: 'integration-clone', profileDir: profiles, cwd: lane, repoPath: lane,
        binary: process.execPath, args: [], homeDir: home, gitBranch: { lane: 'inline/pkt-merge' },
      });
      const run = spawnSync(prepared.binary, [...prepared.args, '-e', WORKER_STEPS, gitDir], {
        cwd: lane, encoding: 'utf8', env: { ...process.env, HOME: home },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ editConfig: 'refused', addHook: 'refused' });
      expect(readFileSync(join(gitDir, 'config'), 'utf8')).toBe(config);
      expect(existsSync(join(gitDir, 'hooks', 'post-rewrite'))).toBe(false);
    } finally {
      await integration.cleanup();
    }
  }, 60_000);
});
