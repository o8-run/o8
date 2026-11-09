import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveGitBinary } from '@/lib/git/binary';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';
import { requireBwrap } from '@/lib/runtimes/shared/owned-session/sandbox-linux';

// A sandboxed packet worker shares the repository's .git with the operator's
// checkout and every other lane. It may commit to its own branch; it may not
// change the base branch, another lane, the repository config, hooks, or the
// operator's checkout state.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-git-guard-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gitBinary = resolveGitBinary();
const identity = {
  GIT_AUTHOR_NAME: 'o8 test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'o8 test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync(gitBinary, args, {
  cwd, encoding: 'utf8', env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// The worker's own process: every step reports whether the sandbox let it through.
const WORKER_STEPS = String.raw`
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [gitBinary, common, otherAdmin, ownAdmin] = process.argv.slice(1);
const result = {};
const step = (name, run) => { try { run(); result[name] = 'allowed'; } catch { result[name] = 'refused'; } };
const git = (...args) => execFileSync(gitBinary, args, { stdio: 'pipe' });
step('commitOwnBranch', () => { fs.writeFileSync('change.txt', 'worker\n'); git('add', 'change.txt'); git('commit', '-qm', 'worker change'); });
step('moveBaseBranch', () => git('update-ref', 'refs/heads/main', 'HEAD'));
step('moveOtherLane', () => git('update-ref', 'refs/heads/inline/pkt-other', 'HEAD'));
step('createRef', () => git('update-ref', 'refs/heads/worker-made', 'HEAD'));
step('packRefs', () => git('pack-refs', '--all'));
step('editConfig', () => git('config', 'remote.origin.url', '/worker/remote'));
step('addHook', () => fs.writeFileSync(path.join(common, 'hooks', 'post-merge'), '#!/bin/sh\n'));
step('editInfo', () => fs.writeFileSync(path.join(common, 'info', 'exclude'), 'worker\n'));
step('addAlternate', () => fs.writeFileSync(path.join(common, 'objects', 'info', 'alternates'), '/worker/objects\n'));
step('operatorIndex', () => fs.writeFileSync(path.join(common, 'index'), 'worker'));
step('operatorHead', () => fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/worker-made\n'));
step('otherLaneHead', () => fs.writeFileSync(path.join(otherAdmin, 'HEAD'), 'worker\n'));
step('ownCommondir', () => fs.writeFileSync(path.join(ownAdmin, 'commondir'), '/worker\n'));
// A hard link from a writable path to a protected file must not open a way to write it.
step('linkConfig', () => { fs.linkSync(path.join(common, 'config'), path.join(ownAdmin, 'linked-config')); fs.appendFileSync(path.join(ownAdmin, 'linked-config'), '[core]\n\tfsmonitor = /worker\n'); });
step('moveHooks', () => fs.renameSync(path.join(common, 'objects', 'info'), path.join(common, 'hooks-swap')));
step('configWorktree', () => fs.writeFileSync(path.join(ownAdmin, 'config.worktree'), '[core]\n\tfsmonitor = /worker\n'));
// Moving a directory that holds a protected entry carries the entry with it.
step('moveOwnAdmin', () => fs.renameSync(ownAdmin, path.join(common, 'objects', 'moved-admin')));
step('moveObjectInfo', () => fs.renameSync(path.join(common, 'objects', 'info'), path.join(common, 'objects', 'info-moved')));
step('moveObjects', () => fs.renameSync(path.join(common, 'objects'), path.join(ownAdmin, 'objects-moved')));
step('moveCheckout', () => fs.renameSync(process.cwd(), path.join(process.env.TMPDIR, 'moved-checkout')));
process.stdout.write(JSON.stringify(result));
`;

const sandboxUsable = process.platform === 'darwin'
  ? existsSync('/usr/bin/sandbox-exec')
  : process.platform === 'linux' && await requireBwrap().then(() => true, () => false);

describe.runIf(sandboxUsable)('worker Git metadata through the production sandbox', () => {
  it("lets a worker commit to its own branch and nothing else in the shared .git", async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
    const lane = join(root, 'lane');
    const other = join(root, 'other');
    git(repo, 'worktree', 'add', '-q', '-b', 'inline/pkt-guard', lane, 'main');
    git(repo, 'worktree', 'add', '-q', '-b', 'inline/pkt-other', other, 'main');
    const common = join(repo, '.git');
    const ownAdmin = git(lane, 'rev-parse', '--path-format=absolute', '--git-dir');
    const otherAdmin = git(other, 'rev-parse', '--path-format=absolute', '--git-dir');
    mkdirSync(join(common, 'hooks'), { recursive: true });
    mkdirSync(join(common, 'objects', 'info'), { recursive: true });

    const before = {
      main: git(repo, 'rev-parse', 'refs/heads/main'),
      other: git(repo, 'rev-parse', 'refs/heads/inline/pkt-other'),
      config: readFileSync(join(common, 'config'), 'utf8'),
      index: readFileSync(join(common, 'index')),
      head: readFileSync(join(common, 'HEAD'), 'utf8'),
      otherHead: readFileSync(join(otherAdmin, 'HEAD'), 'utf8'),
      commondir: readFileSync(join(ownAdmin, 'commondir'), 'utf8'),
    };

    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const data = join(root, 'data');
    const profiles = join(root, 'profiles');
    for (const dir of [home, temp, data, profiles]) mkdirSync(dir, { recursive: true });
    const prepared = await prepareWorkerSandbox({
      runId: 'git-guard', profileDir: profiles, cwd: lane, repoPath: lane,
      binary: process.execPath, args: [], homeDir: home, tmpDir: temp, gitBranch: { lane: 'inline/pkt-guard' },
    });
    const run = spawnSync(prepared.binary, [...prepared.args, '-e', WORKER_STEPS, gitBinary, common, otherAdmin, ownAdmin], {
      cwd: lane, encoding: 'utf8',
      env: { ...process.env, ...identity, HOME: home, TMPDIR: temp, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      commitOwnBranch: 'allowed',
      moveBaseBranch: 'refused',
      // Linux mounts cannot split one ref directory: lanes sharing it stay writable there.
      moveOtherLane: process.platform === 'linux' ? 'allowed' : 'refused',
      createRef: 'refused',
      packRefs: 'refused',
      editConfig: 'refused',
      addHook: 'refused',
      editInfo: 'refused',
      addAlternate: 'refused',
      operatorIndex: 'refused',
      operatorHead: 'refused',
      otherLaneHead: 'refused',
      ownCommondir: 'refused',
      linkConfig: 'refused',
      moveHooks: 'refused',
      configWorktree: 'refused',
      moveOwnAdmin: 'refused',
      moveObjectInfo: 'refused',
      moveObjects: 'refused',
      moveCheckout: 'refused',
    });

    // The host sees the worker's commit on its branch and nothing else changed.
    expect(git(repo, 'log', '-1', '--format=%s', 'refs/heads/inline/pkt-guard')).toBe('worker change');
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(before.main);
    if (process.platform !== 'linux') expect(git(repo, 'rev-parse', 'refs/heads/inline/pkt-other')).toBe(before.other);
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/worker-made')).toThrow();
    expect(existsSync(join(common, 'packed-refs'))).toBe(false);
    expect(readFileSync(join(common, 'config'), 'utf8')).toBe(before.config);
    expect(existsSync(join(common, 'hooks', 'post-merge'))).toBe(false);
    expect(existsSync(join(common, 'objects', 'info', 'alternates'))).toBe(false);
    expect(readFileSync(join(common, 'index')).equals(before.index)).toBe(true);
    expect(readFileSync(join(common, 'HEAD'), 'utf8')).toBe(before.head);
    expect(readFileSync(join(otherAdmin, 'HEAD'), 'utf8')).toBe(before.otherHead);
    expect(readFileSync(join(ownAdmin, 'commondir'), 'utf8')).toBe(before.commondir);
    // Linux binds an empty placeholder over a missing worktree config.
    const configWorktree = join(ownAdmin, 'config.worktree');
    expect(existsSync(configWorktree) ? readFileSync(configWorktree, 'utf8') : '').toBe('');
    expect(existsSync(join(common, 'objects', 'info'))).toBe(true);
    expect(existsSync(join(lane, 'base.txt'))).toBe(true);
  }, 60_000);

  it('guards a linked worktree by its session branch when it has no lane, and leaves a main checkout without a lane unguarded', async () => {
    const repo = join(root, 'session-repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const checkout = join(root, 'session-checkout');
    git(repo, 'worktree', 'add', '-q', '-b', 'inline/session-only', checkout, 'main');
    const home = join(root, 'session-home');
    const temp = join(root, 'session-tmp');
    const profiles = join(root, 'session-profiles');
    for (const dir of [home, temp, profiles]) mkdirSync(dir, { recursive: true });
    const prepare = (cwd: string, gitBranch: { lane?: string; session?: string }, runId: string) => prepareWorkerSandbox({
      runId, profileDir: profiles, cwd, repoPath: cwd, binary: process.execPath, args: [], homeDir: home, tmpDir: temp, gitBranch,
    });
    const linked = await prepare(checkout, { session: 'inline/session-only' }, 'session-linked');
    const main = await prepare(repo, { session: 'main' }, 'session-main');
    // The guard keeps a linked worktree's commondir and a main checkout's packed refs in place.
    const common = join(realpathSync(repo), '.git');
    expect(linked.profileText).toContain(join(common, 'worktrees', 'session-checkout', 'commondir'));
    expect(main.profileText).not.toContain(join(common, 'packed-refs'));
    expect(main.profileText).not.toContain(join(common, 'hooks'));
    if (process.platform === 'linux') {
      await expect(prepare(checkout, { lane: 'pkt-top' }, 'session-top')).rejects.toThrow(/own directory/);
    }
  }, 60_000);
});
