import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  workerSandboxEnabled,
  buildSeatbeltProfile,
  prepareWorkerSandbox,
  SandboxUnavailableError,
  SANDBOX_EXEC_PATH,
  assertNoRegrantOverlap,
  assertNarrowRuntimeStateRegrants,
} from './sandbox';
import { isReadOnlyRuntimeConfig, resolveReadOnlySandboxPlan } from './work-mode';

const isDarwin = process.platform === 'darwin';
const tmpRoots: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.O8_WORKER_SANDBOX;
  while (tmpRoots.length) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('workerSandboxEnabled — feature gate default OFF', () => {
  it('is off when unset (dispatch must never brick on day one)', () => {
    delete process.env.O8_WORKER_SANDBOX;
    expect(workerSandboxEnabled()).toBe(false);
  });

  it('accepts on/1/true/yes and rejects off/anything else', () => {
    for (const on of ['on', '1', 'true', 'yes', 'ON', 'Yes']) {
      process.env.O8_WORKER_SANDBOX = on;
      expect(workerSandboxEnabled()).toBe(true);
    }
    for (const off of ['off', '0', 'false', 'no', '', 'maybe']) {
      process.env.O8_WORKER_SANDBOX = off;
      expect(workerSandboxEnabled()).toBe(false);
    }
  });
});

describe('buildSeatbeltProfile — policy shape', () => {
  const profile = buildSeatbeltProfile({
    worktreePath: '/tmp/wt',
    repoPath: '/tmp/repo',
    homeDir: '/Users/op',
    tmpDir: '/tmp/T',
    finalDenyExecPaths: ['/opt/codex/bin/codex'],
    finalDenyExecNamePrefixes: ['codex'],
    finalDenyReadBasenames: ['codex', 'codex.js'],
    finalDenyWritePaths: ['/tmp/immutable.rules'],
    finalImmutableWritePaths: ['/tmp/active-state/policy.rules'],
    finalAllowReadWritePaths: ['/tmp/active-state'],
    finalAllowReadPaths: ['/tmp/private-codex'],
    finalAllowExecPaths: ['/tmp/private-codex'],
  });

  it('is deny-by-default', () => {
    expect(profile).toContain('(deny default)');
  });

  it('DENIES the operator secret trees (~/.o8, ~/.tauri) and the webview socket', () => {
    // Secret trees are denied explicitly, AFTER the allows (last-match-wins).
    const denyIdx = profile.indexOf('(deny file-read* file-write*\n  (subpath "/Users/op/.o8")');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(profile).toContain('(subpath "/Users/op/.tauri")');
    expect(profile).toContain('#"^/private/tmp/tauri-mcp-o8-"');
    expect(profile).toContain('#"^/tmp/tauri-mcp-o8-"');
    // The secret deny must come after the worktree allow (SBPL last-match-wins).
    const allowIdx = profile.indexOf('(allow file-read* file-write*');
    expect(allowIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  it('DENIES the gh credential store and never allow-lists ~/.zshenv', () => {
    // ~/.config is read-allowed for git, but the gh token store inside it is
    // denied last so a worker cannot lift the operator's GitHub OAuth token.
    const ghDenyIdx = profile.indexOf('(subpath "/Users/op/.config/gh")');
    expect(ghDenyIdx).toBeGreaterThan(profile.indexOf('(allow file-read* file-write*'));
    // ~/.zshenv commonly exports operator API keys; workers inherit env from
    // the trusted parent, so it must not appear in any allow.
    expect(profile).not.toContain('.zshenv');
  });

  it('ALLOWS the worktree + repo read+write and keeps network open (RF-1 HTTP)', () => {
    expect(profile).toContain('(subpath "/tmp/wt")');
    expect(profile).toContain('(subpath "/tmp/repo")');
    expect(profile).toContain('(allow network*)');
  });

  it('allows required cache/session writes while keeping global CLI prefixes read-only', () => {
    expect(profile).toContain('(subpath "/Users/op/.npm")');
    expect(profile).toContain('(subpath "/Users/op/.codex")');
    expect(profile).toContain('(subpath "/Users/op/.claude")');
    expect(profile).toContain('(subpath "/Users/op/.npm-global")');
    const writeAllow = profile.indexOf(';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---');
    expect(profile.indexOf('(subpath "/Users/op/.npm")', writeAllow)).toBeGreaterThan(writeAllow);
    expect(profile.indexOf('(subpath "/Users/op/.npm-global")', writeAllow)).toBe(-1);
    expect(profile.indexOf('(literal "/Users/op/.claude.json")', writeAllow)).toBeGreaterThan(writeAllow);
    const codexConfigDeny = profile.lastIndexOf('(literal "/Users/op/.codex/config.toml")');
    const claudeSettingsDeny = profile.lastIndexOf('(literal "/Users/op/.claude/settings.json")');
    expect(codexConfigDeny).toBeGreaterThan(profile.indexOf('(subpath "/Users/op/.codex")', writeAllow));
    expect(claudeSettingsDeny).toBeGreaterThan(profile.indexOf('(subpath "/Users/op/.claude")', writeAllow));
  });

  it('does NOT whitelist HOME wholesale (so ~/.o8 stays out of the read allowlist)', () => {
    expect(profile).not.toContain('(subpath "/Users/op")\n');
    // toolchain subdirs are allowed, but never .o8 as a READ root
    expect(profile).toContain('(subpath "/Users/op/.codex")');
  });

  it('can grant Ori state read access without making the credential tree writable', () => {
    const oriProfile = buildSeatbeltProfile({
      worktreePath: '/tmp/wt',
      repoPath: '/tmp/repo',
      homeDir: '/Users/op',
      tmpDir: '/tmp/T',
      extraReadPaths: ['/Users/op/.ori'],
    });
    const readAllow = oriProfile.indexOf(';; --- read: system + toolchain roots ---');
    const writeAllow = oriProfile.indexOf(';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---');
    expect(oriProfile.indexOf('(subpath "/Users/op/.ori")', readAllow)).toBeGreaterThan(readAllow);
    expect(oriProfile.indexOf('(subpath "/Users/op/.ori")', writeAllow)).toBe(-1);
  });

  it('can deny protected executable paths and keep launch policy immutable', () => {
    expect(profile).toContain('(deny process-exec\n  (literal "/opt/codex/bin/codex")');
    expect(profile).toContain('(regex #"(^|/)codex(?:$|[-.])")');
    expect(profile).toContain('(regex #"(^|/)codex\\.js$")');
    expect(profile).toContain('file-link file-clone\n  (literal "/tmp/immutable.rules")');
    expect(profile).toContain('(allow file-read* file-write*\n  (subpath "/tmp/active-state")');
    const activeStateAllow = profile.indexOf('(allow file-read* file-write*\n  (subpath "/tmp/active-state")');
    const activePolicyDeny = profile.indexOf('(literal "/tmp/active-state/policy.rules")');
    expect(activePolicyDeny).toBeGreaterThan(activeStateAllow);
    const execDeny = profile.indexOf('(deny process-exec');
    const execAllow = profile.indexOf('(allow process-exec\n  (literal "/tmp/private-codex")');
    expect(execAllow).toBeGreaterThan(execDeny);
    expect(profile).toContain('(allow file-read*\n  (literal "/tmp/private-codex")');
  });
});

describe('verified CLI ancestor protection', () => {
  it('denies exact ancestor directory writes after mutable grants without denying their contents', () => {
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/packet', repoPath: '/tmp/packet', homeDir: '/operator', tmpDir: '/tmp',
      finalAllowReadWritePaths: ['/tmp/runtime'], finalImmutableWritePaths: ['/tmp/data/worker-cli'],
      finalImmutableAncestorPaths: ['/tmp/data', '/tmp', '/'],
    });
    const block = profile.slice(profile.indexOf(';; keep verified CLI ancestors immutable'));
    expect(block).toContain('(literal "/tmp/data")');
    expect(block).toContain('(literal "/tmp")');
    expect(block).toContain('(literal "/")');
    expect(block).not.toContain('(subpath');
    expect(profile.indexOf(';; keep verified CLI ancestors immutable')).toBeGreaterThan(profile.lastIndexOf('(allow file-read* file-write*'));
  });

  it.skipIf(!isDarwin)('refuses ancestor replacement and CLI changes while allowing sibling writes', () => {
    const root = realpathSync(tmpRoot('o8-cli-ancestors-'));
    const data = path.join(root, 'data');
    const cli = path.join(data, 'worker-cli'); mkdirSync(cli, { recursive: true });
    const bundle = path.join(cli, 'o8.mjs'); writeFileSync(bundle, 'verified');
    const ancestors: string[] = [];
    for (let current = data; ; current = path.dirname(current)) {
      ancestors.push(current); if (current === path.dirname(current)) break;
    }
    const profile = buildSeatbeltProfile({ worktreePath: root, repoPath: root,
      homeDir: os.homedir(), tmpDir: root, extraDenyPaths: [data],
      finalAllowReadPaths: [cli, bundle], finalImmutableWritePaths: [cli], finalImmutableAncestorPaths: ancestors,
    });
    const result = JSON.parse(execFileSync(SANDBOX_EXEC_PATH, ['-p', profile, process.execPath, '-e', `
      const fs = require('node:fs');
      const denied = action => { try { action(); return false; } catch { return true; } };
      fs.writeFileSync(${JSON.stringify(path.join(root, 'sibling.txt'))}, 'allowed');
      console.log(JSON.stringify({
        bundle: denied(() => fs.writeFileSync(${JSON.stringify(bundle)}, 'changed')),
        rename: denied(() => fs.renameSync(${JSON.stringify(data)}, ${JSON.stringify(data + '-moved')})),
        ancestor: denied(() => fs.renameSync(${JSON.stringify(root)}, ${JSON.stringify(root + '-moved')})),
        symlink: denied(() => { fs.unlinkSync(${JSON.stringify(bundle)}); fs.symlinkSync(${JSON.stringify(root)}, ${JSON.stringify(bundle)}); }),
      }));
    `], { encoding: 'utf8' }));
    if (existsSync(root + '-moved')) renameSync(root + '-moved', root);
    if (existsSync(data + '-moved')) renameSync(data + '-moved', data);
    expect(result).toEqual({ bundle: true, rename: true, ancestor: true, symlink: true });
    expect(readFileSync(path.join(root, 'sibling.txt'), 'utf8')).toBe('allowed');
    expect(readFileSync(bundle, 'utf8')).toBe('verified');
  });
});

describe('prepareWorkerSandbox — the exact wrapper store.ts spawns', () => {
  it.skipIf(!isDarwin)('wraps binary+args with sandbox-exec -f <profile> (enabled path)', async () => {
    const worktree = tmpRoot('o8-sbx-wt-');
    const profileDir = tmpRoot('o8-sbx-prof-');
    const prepared = await prepareWorkerSandbox({
      runId: 'run-123',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/usr/local/bin/codex',
      args: ['exec', '--json', 'do the thing'],
    });

    // (a) wrapper + profile args are present and ordering is exact.
    expect(prepared.binary).toBe(SANDBOX_EXEC_PATH);
    expect(prepared.args[0]).toBe('-f');
    expect(prepared.args[1]).toBe(prepared.profilePath);
    expect(prepared.args[2]).toBe('/usr/local/bin/codex');
    expect(prepared.args.slice(3)).toEqual(['exec', '--json', 'do the thing']);
    expect(existsSync(prepared.profilePath)).toBe(true);

    // (b) generated profile denies ~/.o8 and allows the worktree.
    expect(prepared.profileText).toContain(`(subpath "${path.join(os.homedir(), '.o8')}")`);
    expect(prepared.profileText).not.toContain('(subpath "/")');
  });

  it.skipIf(!isDarwin)('permits Claude root-state atomic writes without opening HOME', async () => {
    const home = tmpRoot('o8-sbx-home-');
    const worktree = tmpRoot('o8-sbx-wt-');
    const profileDir = tmpRoot('o8-sbx-prof-');
    const prepared = await prepareWorkerSandbox({
      runId: 'claude-root-state',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/sh',
      args: [],
      homeDir: home,
    });

    execFileSync(
      SANDBOX_EXEC_PATH,
      ['-f', prepared.profilePath, '/bin/sh', '-c', 'printf ok > "$HOME/.claude.json.tmp" && mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"'],
      { env: { ...process.env, HOME: home }, stdio: 'ignore' },
    );
    expect(existsSync(path.join(home, '.claude.json'))).toBe(true);
    expect(prepared.profileText).not.toContain(`(subpath "${home}")`);
  });

  it.skipIf(!isDarwin)('includes and enforces a real packet worktree git dir and backing common dir', async () => {
    const repo = tmpRoot('o8-sbx-repo-');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'sandbox@example.test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Sandbox Test']);
    writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '--', 'tracked.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    const packetWorktree = tmpRoot('o8-sbx-packet-');
    rmSync(packetWorktree, { recursive: true, force: true });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'packet/sandbox-profile', packetWorktree]);
    const profileDir = tmpRoot('o8-sbx-prof-');

    const prepared = await prepareWorkerSandbox({
      runId: 'real-packet-paths',
      profileDir,
      cwd: packetWorktree,
      repoPath: packetWorktree,
      binary: '/bin/sh',
      args: ['-lc', 'git status --short'],
    });
    const gitPaths = execFileSync(
      'git',
      ['-C', packetWorktree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8' },
    ).trim().split(/\r?\n/);

    expect(prepared.profileText).toContain(`(subpath "${packetWorktree}")`);
    for (const gitPath of gitPaths) {
      expect(prepared.profileText).toContain(`(subpath "${gitPath}")`);
    }
    const status = execFileSync(
      SANDBOX_EXEC_PATH,
      ['-f', prepared.profilePath, '/usr/bin/git', '-C', packetWorktree, 'status', '--short'],
      { encoding: 'utf8' },
    );
    expect(status).toBe('');
  });

  it('is FAIL-CLOSED — throws SandboxUnavailableError when the profile cannot be written', async () => {
    // An unwritable profile dir must refuse, never spawn unsandboxed. Hosts
    // without a sandbox backend (or without bwrap on Linux) refuse earlier.
    await expect(prepareWorkerSandbox({
      runId: 'r',
      profileDir: '/this/path/does/not/exist/and/is/unwritable',
      cwd: '/tmp',
      repoPath: '/tmp',
      binary: '/bin/echo',
      args: [],
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

describe('read-only packet runs write-deny the worktree', () => {
  it('maps a read-only session onto the repo and worktree, and nothing else', () => {
    expect(isReadOnlyRuntimeConfig({ workMode: 'read-only' })).toBe(true);
    expect(isReadOnlyRuntimeConfig({ modelSource: 'native' })).toBe(false);
  });

  it('emits the worktree write denial AFTER the worktree read+write allow', () => {
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/wt',
      repoPath: '/tmp/repo',
      homeDir: '/Users/op',
      tmpDir: '/tmp/T',
      readOnlyDenyWritePaths: ['/tmp/repo', '/tmp/wt'],
    });
    // The worktree stays READABLE — a read-only packet still has to inspect it.
    const allowIdx = profile.indexOf(';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---');
    expect(profile.indexOf('(subpath "/tmp/wt")', allowIdx)).toBeGreaterThan(allowIdx);
    // …and SBPL is last-match-wins, so the write denial has to come after it.
    const denyIdx = profile.lastIndexOf('(subpath "/tmp/wt")');
    expect(profile.lastIndexOf('(deny file-write*', denyIdx)).toBeGreaterThan(allowIdx);
    expect(denyIdx).toBeGreaterThan(profile.indexOf('(subpath "/tmp/wt")', allowIdx));
  });
});

// The reachability proof: the generated policy, run through the REAL
// sandbox-exec, actually blocks a secret read and permits a worktree read.
describe('sandbox policy is live-enforced (real sandbox-exec)', () => {
  it.skipIf(!isDarwin)('REJECTS a read-only packet write to the worktree while reads still work', async () => {
    const home = tmpRoot('o8-sbx-ro-home-');
    const worktree = tmpRoot('o8-sbx-ro-wt-');
    // A real repo: `enforceReadOnly` derives its denials from the git probe and
    // refuses outright when that probe resolves nothing.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
    writeFileSync(path.join(worktree, 'code.ts'), 'export const ok = true;');
    const profileDir = tmpRoot('o8-sbx-ro-prof-');

    const prepared = await prepareWorkerSandbox({
      runId: 'live-read-only',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/sh',
      args: [],
      homeDir: home,
      enforceReadOnly: true,
    });
    const profileArg = prepared.args[1];

    // ALLOW: inspection is the whole point of a read-only packet.
    const out = execFileSync(SANDBOX_EXEC_PATH,
      ['-f', profileArg, '/bin/cat', path.join(worktree, 'code.ts')],
      { encoding: 'utf8' });
    expect(out).toContain('export const ok = true;');

    // DENY: the shell write the argv-level tool deny cannot reach is refused.
    const target = path.join(worktree, 'code.ts');
    let denied = false;
    try {
      execFileSync(SANDBOX_EXEC_PATH,
        ['-f', profileArg, '/bin/sh', '-c', `echo mutated > ${target}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('export const ok = true;');

    // DENY: creating a new file in the worktree is refused too.
    let createDenied = false;
    try {
      execFileSync(SANDBOX_EXEC_PATH,
        ['-f', profileArg, '/bin/sh', '-c', `echo new > ${path.join(worktree, 'added.ts')}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      createDenied = true;
    }
    expect(createDenied).toBe(true);
    expect(existsSync(path.join(worktree, 'added.ts'))).toBe(false);
  });

  it.skipIf(!isDarwin)('REJECTS git metadata writes for a linked read-only worktree', async () => {
    const home = tmpRoot('o8-sbx-ro-git-home-');
    const repo = tmpRoot('o8-sbx-ro-git-repo-');
    const worktreeParent = tmpRoot('o8-sbx-ro-git-wt-parent-');
    const worktree = path.join(worktreeParent, 'worktree');
    const profileDir = tmpRoot('o8-sbx-ro-git-prof-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'o8-test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@invalid'], { cwd: repo });
    writeFileSync(path.join(repo, 'code.ts'), 'export const ok = true;');
    execFileSync('git', ['add', 'code.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-qb', 'read-only-check', worktree], { cwd: repo });
    const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' });

    const plan = resolveReadOnlySandboxPlan({ runtimeConfig: { workMode: 'read-only' } });
    expect(plan.enforced).toBe(true);
    const prepared = await prepareWorkerSandbox({
      runId: 'live-read-only-git',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/usr/bin/git',
      args: [],
      homeDir: home,
      enforceReadOnly: plan.enforced,
    });
    // The git metadata dir the sandbox GRANTED is the same one it denied — one
    // probe, no chance of the grant and the deny disagreeing (blocker #3).
    expect(prepared.profileText).toContain(realpathSync(path.join(repo, '.git')));

    expect(() => execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.args[1], '/usr/bin/git', '-C', worktree,
      'commit', '--allow-empty', '-m', 'must-not-land',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }))
      .toBe(beforeHead);
  });

  it.skipIf(!isDarwin)('keeps a normal write packet writable (control)', async () => {
    const home = tmpRoot('o8-sbx-rw-home-');
    const worktree = tmpRoot('o8-sbx-rw-wt-');
    const profileDir = tmpRoot('o8-sbx-rw-prof-');

    const prepared = await prepareWorkerSandbox({
      runId: 'live-write',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/sh',
      args: [],
      homeDir: home,
    });
    execFileSync(SANDBOX_EXEC_PATH,
      ['-f', prepared.args[1], '/bin/sh', '-c', `echo written > ${path.join(worktree, 'added.ts')}`],
      { encoding: 'utf8' });
    expect(readFileSync(path.join(worktree, 'added.ts'), 'utf8')).toContain('written');
  });

  it.skipIf(!isDarwin)('denies ~/.o8-style secret reads, allows the worktree', async () => {
    const home = tmpRoot('o8-sbx-home-');
    const secretDir = path.join(home, '.o8');
    // create the fake secret tree
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, 'ws-token'), 'TOPSECRET');

    const worktree = tmpRoot('o8-sbx-wt-');
    writeFileSync(path.join(worktree, 'code.ts'), 'export const ok = true;');
    const profileDir = tmpRoot('o8-sbx-prof-');

    const prepared = await prepareWorkerSandbox({
      runId: 'live',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/cat',
      args: [],
      homeDir: home,
    });
    const profileArg = prepared.args[1];

    // ALLOW: reading a worktree file succeeds.
    const out = execFileSync(SANDBOX_EXEC_PATH,
      ['-f', profileArg, '/bin/cat', path.join(worktree, 'code.ts')],
      { encoding: 'utf8' });
    expect(out).toContain('export const ok = true;');

    // DENY: reading the operator secret is refused (non-zero exit).
    let denied = false;
    try {
      execFileSync(SANDBOX_EXEC_PATH,
        ['-f', profileArg, '/bin/cat', path.join(secretDir, 'ws-token')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });

  it.skipIf(!isDarwin)(
    'denies relocated O8 and legacy data roots while keeping the packet worktree readable',
    async () => {
      const previousO8DataDir = process.env.O8_DATA_DIR;
      const previousCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
      const root = tmpRoot('o8-sbx-relocated-roots-');
      const home = path.join(root, 'home');
      const o8DataDir = path.join(root, 'operator-state');
      const cortexDataDir = path.join(root, 'legacy-state');
      const worktree = path.join(o8DataDir, 'worktrees', 'packet-1');
      const profileDir = path.join(root, 'profiles');
      const currentSecret = path.join(o8DataDir, 'ws-token');
      const legacySecret = path.join(cortexDataDir, 'worker-token');
      mkdirSync(home, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      mkdirSync(profileDir, { recursive: true });
      mkdirSync(cortexDataDir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
      writeFileSync(path.join(worktree, 'code.ts'), 'export const readable = true;\n');
      writeFileSync(currentSecret, 'CURRENT_SECRET\n');
      writeFileSync(legacySecret, 'LEGACY_SECRET\n');
      process.env.O8_DATA_DIR = o8DataDir;
      process.env.CORTEX_IDE_DATA_DIR = cortexDataDir;

      try {
        const prepared = await prepareWorkerSandbox({
          runId: 'relocated-data-roots',
          profileDir,
          cwd: worktree,
          repoPath: worktree,
          binary: '/bin/cat',
          args: [],
          homeDir: home,
          enforceReadOnly: true,
        });
        expect(prepared.profileText).toContain(`(subpath "${o8DataDir}")`);
        expect(prepared.profileText).toContain(`(subpath "${cortexDataDir}")`);

        const output = execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/cat', path.join(worktree, 'code.ts'),
        ], { encoding: 'utf8' });
        expect(output).toContain('export const readable = true;');

        for (const secretPath of [currentSecret, legacySecret]) {
          expect(() => execFileSync(SANDBOX_EXEC_PATH, [
            '-f', prepared.profilePath, '/bin/cat', secretPath,
          ], { stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
        }
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/sh', '-c',
          `printf mutated > ${JSON.stringify(path.join(worktree, 'code.ts'))}`,
        ], { stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
        expect(readFileSync(path.join(worktree, 'code.ts'), 'utf8'))
          .toBe('export const readable = true;\n');

        const writePrepared = await prepareWorkerSandbox({
          runId: 'relocated-data-write-control',
          profileDir,
          cwd: worktree,
          repoPath: worktree,
          binary: '/bin/sh',
          args: [],
          homeDir: home,
        });
        const writeTarget = path.join(worktree, 'write-control.txt');
        execFileSync(SANDBOX_EXEC_PATH, [
          '-f', writePrepared.profilePath, '/bin/sh', '-c',
          `printf allowed > ${JSON.stringify(writeTarget)}`,
        ], { stdio: 'ignore' });
        expect(readFileSync(writeTarget, 'utf8')).toBe('allowed');
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', writePrepared.profilePath, '/bin/cat', legacySecret,
        ], { stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
      } finally {
        if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
        else process.env.O8_DATA_DIR = previousO8DataDir;
        if (previousCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
        else process.env.CORTEX_IDE_DATA_DIR = previousCortexDataDir;
      }
    },
  );

  it.skipIf(!isDarwin)('denies outbound access to pre-existing tmux-shaped sockets', async () => {
    const socketDir = `/tmp/tmux-o8-sandbox-${process.pid}`;
    const socketPath = path.join(socketDir, 'default');
    mkdirSync(socketDir, { recursive: true });
    tmpRoots.push(socketDir);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const worktree = tmpRoot('o8-sbx-wt-');
      const profileDir = tmpRoot('o8-sbx-prof-');
      const prepared = await prepareWorkerSandbox({
        runId: 'tmux-socket',
        profileDir,
        cwd: worktree,
        repoPath: worktree,
        binary: process.execPath,
        args: [],
      });
      const client = [
        "const net=require('node:net')",
        `const s=net.createConnection(${JSON.stringify(socketPath)})`,
        "s.on('connect',()=>process.exit(0))",
        "s.on('error',()=>process.exit(7))",
        'setTimeout(()=>process.exit(8),1000)',
      ].join(';');

      let denied = false;
      try {
        execFileSync(SANDBOX_EXEC_PATH,
          ['-f', prepared.profilePath, process.execPath, '-e', client],
          { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('read-only enforcement — single git probe, fail-closed, correct order', () => {
  it('emits the read-only denial AFTER every allow, including narrow re-opens', () => {
    // SBPL is last-match-wins. An identity config home passed as
    // finalAllowReadWritePaths must not be able to REGRANT write access to a
    // subtree the read-only run denied, so the read-only block lands dead last.
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/wt',
      repoPath: '/tmp/wt',
      homeDir: '/Users/op',
      tmpDir: '/tmp/T',
      finalAllowReadWritePaths: ['/tmp/identity-home'],
      finalAllowExecPaths: ['/tmp/private-codex'],
      readOnlyDenyWritePaths: ['/tmp/wt'],
    });
    const readOnlyIndex = profile.indexOf('read-only packet: repository stays readable');
    expect(readOnlyIndex).toBeGreaterThan(-1);
    expect(readOnlyIndex).toBeGreaterThan(profile.indexOf('/tmp/identity-home'));
    expect(readOnlyIndex).toBeGreaterThan(profile.indexOf('/tmp/private-codex'));
    // It is the last rule block in the profile.
    expect(profile.indexOf('(allow', readOnlyIndex)).toBe(-1);
  });

  it('leaves the existing deny-parent / re-open-child idiom intact', () => {
    // single-orchestrator-policy denies a broad `.single-turns` root then
    // re-opens THIS turn's home inside it. That allow must still win.
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/wt',
      repoPath: '/tmp/wt',
      homeDir: '/Users/op',
      tmpDir: '/tmp/T',
      finalDenyWritePaths: ['/tmp/turns'],
      finalAllowReadWritePaths: ['/tmp/turns/active/home'],
    });
    expect(profile.indexOf('/tmp/turns/active/home'))
      .toBeGreaterThan(profile.indexOf('immutable launch policy and guards'));
  });

  it('refuses a profile whose re-open overlaps a write denial', () => {
    // Order alone keeps the deny authoritative; an overlap still means the
    // caller believes a denied subtree is writable, so refuse to build it.
    expect(() => assertNoRegrantOverlap(['/tmp/wt/state'], ['/tmp/wt']))
      .toThrow(SandboxUnavailableError);
    expect(() => assertNoRegrantOverlap(['/tmp/wt'], ['/tmp/wt']))
      .toThrow(SandboxUnavailableError);
    // Sibling paths are not an overlap — the common write-packet shape.
    expect(() => assertNoRegrantOverlap(['/tmp/identity'], ['/tmp/wt'])).not.toThrow();
    // A shared string prefix that is not a path boundary is not an overlap.
    expect(() => assertNoRegrantOverlap(['/tmp/wt-other'], ['/tmp/wt'])).not.toThrow();
  });

  it('refuses runtime-state grants that contain HOME, data, or session roots', () => {
    expect(() => assertNarrowRuntimeStateRegrants(
      ['/Users/op'],
      ['/Users/op', '/Users/op/.o8', '/Users/op/.o8/owned/session-1'],
    )).toThrow(SandboxUnavailableError);
    expect(() => assertNarrowRuntimeStateRegrants(
      ['/Users/op/.o8'],
      ['/Users/op', '/Users/op/.o8', '/Users/op/.o8/owned/session-1'],
    )).toThrow(SandboxUnavailableError);
    expect(() => assertNarrowRuntimeStateRegrants(
      ['/Users/op/.o8/owned/session-1'],
      ['/Users/op', '/Users/op/.o8', '/Users/op/.o8/owned/session-1'],
    )).toThrow(SandboxUnavailableError);
    expect(() => assertNarrowRuntimeStateRegrants(
      ['/Users/op/.o8/owned/session-1/claude-code-worker-config'],
      ['/Users/op', '/Users/op/.o8', '/Users/op/.o8/owned/session-1'],
    )).not.toThrow();
    expect(() => assertNarrowRuntimeStateRegrants(
      ['relative/runtime-state'],
      ['/Users/op'],
    )).toThrow(SandboxUnavailableError);
  });

  it.skipIf(!isDarwin)('refuses a symlinked runtime-state grant that resolves to the session root', async () => {
    const root = tmpRoot('o8-sbx-runtime-state-link-');
    const home = path.join(root, 'home');
    const worktree = path.join(home, 'repo');
    const sessionDir = path.join(root, 'data', 'owned', 'session-1');
    const profileDir = path.join(sessionDir, 'runs');
    const configLink = path.join(sessionDir, 'claude-code-worker-config');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
    symlinkSync(sessionDir, configLink, 'dir');

    await expect(prepareWorkerSandbox({
      runId: 'symlink-runtime-state',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/sh',
      args: [],
      homeDir: home,
      enforceReadOnly: true,
      finalAllowReadWritePaths: [configLink],
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it.skipIf(!isDarwin)('denies creation of missing policy files beneath a symlinked state root', async () => {
    const root = tmpRoot('o8-sbx-missing-policy-');
    const worktree = path.join(root, 'repo');
    const config = path.join(root, 'session', 'config');
    const alias = path.join(root, 'state-alias');
    const profileDir = path.join(root, 'session', 'runs');
    mkdirSync(worktree);
    mkdirSync(config, { recursive: true });
    mkdirSync(profileDir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
    symlinkSync(config, alias, 'dir');
    const protectedFiles = ['settings.json', path.join('hooks', 'guard.js')];
    const prepared = await prepareWorkerSandbox({
      runId: 'missing-policy', profileDir, cwd: worktree, repoPath: worktree,
      binary: '/bin/sh', args: [], enforceReadOnly: true,
      finalAllowReadWritePaths: [alias],
      finalImmutableWritePaths: protectedFiles.map((file) => path.join(alias, file)),
    });
    for (const file of protectedFiles) {
      expect(existsSync(path.join(config, file))).toBe(false);
      const canonical = path.join(realpathSync(config), file);
      expect(prepared.profileText).toContain(`(literal "${canonical}")`);
      for (const configRoot of [alias, config]) {
        const destination = path.join(configRoot, file);
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', prepared.profilePath, '/bin/sh', '-c',
          `mkdir -p ${JSON.stringify(path.dirname(destination))} && printf blocked > ${JSON.stringify(destination)}`,
        ], { stdio: 'ignore' })).toThrow();
        expect(existsSync(path.join(config, file))).toBe(false);
      }
    }
    // Ordinary scratch remains writable beneath the same prepared state root.
    const scratch = path.join(alias, 'scratch.json');
    execFileSync(SANDBOX_EXEC_PATH, [
      '-f', prepared.profilePath, '/bin/sh', '-c', `printf allowed > ${JSON.stringify(scratch)}`,
    ]);
    expect(readFileSync(scratch, 'utf8')).toBe('allowed');

    const dangling = path.join(root, 'dangling-state');
    symlinkSync(path.join(root, 'future-state'), dangling, 'dir');
    await expect(prepareWorkerSandbox({
      runId: 'dangling-policy', profileDir, cwd: worktree, repoPath: worktree,
      binary: '/bin/sh', args: [], enforceReadOnly: true,
      finalAllowReadWritePaths: [dangling],
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it.skipIf(!isDarwin)('refuses a read-only launch when the git probe resolves nothing', async () => {
    // A non-git dir cannot resolve git metadata paths. Granting repo access
    // that cannot be write-denied would silently widen the packet, so the
    // sandbox refuses instead (blocker #3, fail-closed).
    const plainDir = tmpRoot('o8-sbx-ro-nogit-');
    const profileDir = tmpRoot('o8-sbx-ro-nogit-prof-');
    await expect(prepareWorkerSandbox({
      runId: 'read-only-no-git',
      profileDir,
      cwd: plainDir,
      repoPath: plainDir,
      binary: '/bin/sh',
      args: [],
      homeDir: tmpRoot('o8-sbx-ro-nogit-home-'),
      enforceReadOnly: true,
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it.skipIf(!isDarwin)('leaves a normal write packet unaffected by the probe failure rule', async () => {
    // Control: the same non-git dir builds a profile fine for a write packet.
    const plainDir = tmpRoot('o8-sbx-rw-nogit-');
    const profileDir = tmpRoot('o8-sbx-rw-nogit-prof-');
    const prepared = await prepareWorkerSandbox({
      runId: 'write-no-git',
      profileDir,
      cwd: plainDir,
      repoPath: plainDir,
      binary: '/bin/sh',
      args: [],
      homeDir: tmpRoot('o8-sbx-rw-nogit-home-'),
    });
    expect(prepared.binary).toBe(SANDBOX_EXEC_PATH);
    expect(prepared.profileText).not.toContain('read-only packet: repository stays readable');
  });

  it('treats only a pinned read-only runtimeConfig as enforced', () => {
    expect(resolveReadOnlySandboxPlan({ runtimeConfig: { workMode: 'read-only' } }).enforced).toBe(true);
    expect(resolveReadOnlySandboxPlan({ runtimeConfig: { workMode: 'edit' } }).enforced).toBe(false);
    expect(resolveReadOnlySandboxPlan({}).enforced).toBe(false);
    expect(isReadOnlyRuntimeConfig(undefined)).toBe(false);
  });
});
