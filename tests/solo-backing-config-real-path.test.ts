import { execFileSync, spawn } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSingleOrchestratorLaunch } from '@/lib/lane/single-orchestrator-policy';
import { prepareWorkerSandbox, SANDBOX_EXEC_PATH } from '@/lib/runtimes/shared/owned-session/sandbox';

const native = vi.hoisted(() => ({
  platform: process.platform, refused: false, probes: [] as string[][],
  configPath: '', resolutions: 0, inspectRefused: false,
}));

// Linux proves the real Git discovery and persisted policy, with only the
// unavailable kernel boundary substituted. macOS executes that boundary too.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: (...args: Parameters<typeof actual.access>) => (
      native.platform !== 'darwin' && args[0] === '/usr/bin/sandbox-exec'
        ? Promise.resolve() : actual.access(...args)
    ),
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      if (args[0] === native.configPath) native.resolutions++;
      return actual.realpath(...args);
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (native.inspectRefused && args[0] === native.configPath) {
        return Promise.reject(Object.assign(new Error('Operation not permitted (os error 1)'), { code: 'EPERM' }));
      }
      return actual.lstat(...args);
    },
  };
});

vi.mock('@/lib/providers/child-process', async (original) => {
  const actual = await original<typeof import('@/lib/providers/child-process')>();
  const execute = promisify(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisify.custom]: async (...args: Parameters<typeof execute>) => {
      if (args[0] === '/usr/bin/sandbox-exec') {
        native.probes.push([...(args[1] as string[])]);
        if (native.refused) throw new Error('Operation not permitted (os error 1)');
        if (native.platform !== 'darwin') return { stdout: '', stderr: '' };
      }
      return execute(...args);
    },
  });
  return { ...actual, execFile };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  native.refused = false;
  native.probes.length = 0;
  native.configPath = '';
  native.resolutions = 0;
  native.inspectRefused = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-solo-config-')));
  roots.push(root);
  const project = join(root, 'project');
  const checkout = join(root, 'checkout');
  const config = join(project, '.codex', 'config.toml');
  const configText = '# backing project configuration\n';
  execFileSync('git', ['init', '-q', project]);
  mkdirSync(dirname(config));
  writeFileSync(config, configText);
  const secrets = [join(project, '.codex', 'auth.json'), join(project, '.codex', 'token'),
    join(project, '.codex', 'config.toml.backup'), join(root, 'ws-token')];
  for (const secret of secrets) writeFileSync(secret, 'synthetic secret');
  execFileSync('git', ['-C', project, 'add', '--', '.codex/config.toml']);
  execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture']);
  execFileSync('git', ['-C', project, 'worktree', 'add', '--detach', checkout], { stdio: 'pipe' });
  const installation = join(root, 'installation');
  mkdirSync(installation);
  const binary = join(installation, 'codex');
  writeFileSync(binary, '#!/bin/sh\nexec "$(dirname "$0")/codex-code-mode-host" "$@"\n', { mode: 0o700 });
  writeFileSync(join(installation, 'codex-code-mode-host'), '#!/bin/sh\nexec /bin/cat "$1"\n', { mode: 0o700 });
  const codexHome = join(root, 'runtime');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), 'runtime configuration must stay closed');
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('O8_DATA_DIR', root);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  native.configPath = config;
  const input = { repoPath: checkout, codexHome, binary, args: [config], env: { ...process.env, PATH: '/usr/bin:/bin' } };
  return { root, project, checkout, config, configText, secrets, input };
}

function lateReadGrant(profile: string): string {
  return profile.slice(profile.indexOf(';; re-open only the active private runtime image'))
    .match(/\(allow file-read\*\n([\s\S]*?)\n\)/)?.[1] ?? '';
}

describe('Solo backing configuration launch boundary', () => {
  it('admits only the immutable backing config in the Solo launch profile', async () => {
    const f = fixture();
    const prepared = await prepareSingleOrchestratorLaunch(f.input);
    try {
      expect(readFileSync(prepared.profilePath, 'utf8')).toBe(prepared.profileText);
      const grant = lateReadGrant(prepared.profileText);
      expect(grant).toContain(`(literal ${JSON.stringify(f.config)})`);
      expect(grant).not.toContain(`(subpath ${JSON.stringify(dirname(f.config))})`);
      for (const secret of [...f.secrets, join(f.input.codexHome, 'config.toml')]) {
        expect(grant).not.toContain(JSON.stringify(secret));
      }
      const immutable = prepared.profileText.slice(prepared.profileText.indexOf(';; keep policy files immutable'));
      expect(immutable).toContain(`file-link file-clone\n`);
      expect(immutable).toContain(`(literal ${JSON.stringify(f.config)})`);
      // A second resolution could follow a replaced symlink to a secret.
      expect(native.resolutions).toBe(1);
      expect(native.probes.at(-1)?.at(-1)).toBe(f.config);
    } finally { prepared.cleanup(); }
  });

  it('reports the refused backing config path and repair step before Solo starts', async () => {
    const f = fixture();
    native.refused = true;
    const failure = await prepareSingleOrchestratorLaunch(f.input).then((prepared) => {
      prepared.cleanup(); return null;
    }, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(`Sandbox refused read access to backing project configuration '${f.config}'. Review the sandbox profile before retrying.`);
    expect(readdirSync(join(f.input.codexHome, '.single-turns'))).toEqual([]);
    expect(readFileSync(join(f.input.codexHome, 'config.toml'), 'utf8')).toBe('runtime configuration must stay closed');
  });

  it('reports the exact config path when inspection itself is refused', async () => {
    const f = fixture();
    native.inspectRefused = true;
    const failure = await prepareSingleOrchestratorLaunch(f.input).then((prepared) => {
      prepared.cleanup(); return null;
    }, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(`Cannot inspect backing project configuration '${f.config}' (EPERM). Review its permissions before retrying.`);
  });

  it('keeps the same config auth and token paths closed without the host opt-in', async () => {
    const f = fixture();
    const prepared = await prepareWorkerSandbox({
      runId: 'other-host', profileDir: f.root, cwd: f.checkout, repoPath: f.checkout,
      binary: process.execPath, args: [], extraDenyPaths: [f.root],
    });
    expect(lateReadGrant(prepared.profileText)).not.toContain(JSON.stringify(f.config));
    expect(prepared.profileText).toContain(`(subpath ${JSON.stringify(f.root)})`);
    expect(native.probes).toEqual([]);
    if (native.platform === 'darwin') {
      for (const file of [f.config, ...f.secrets]) {
        expect(() => execFileSync(prepared.binary, ['-f', prepared.profilePath, '/bin/cat', file], { stdio: 'pipe' })).toThrow();
      }
    }
  });

  it.each(['symlink', 'hardlink'] as const)('refuses a %s config with its exact path', async (kind) => {
    const f = fixture();
    rmSync(f.config);
    if (kind === 'symlink') symlinkSync(f.secrets[0], f.config);
    else linkSync(f.secrets[0], f.config);
    const failure = await prepareSingleOrchestratorLaunch(f.input).then((prepared) => {
      prepared.cleanup(); return null;
    }, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(`Backing project configuration '${f.config}' must be a regular, non-aliased file.`);
  });

  it.skipIf(native.platform !== 'darwin')('runs the relocated host with config access while secrets writes and recursion stay denied', async () => {
    const f = fixture();
    const prepared = await prepareSingleOrchestratorLaunch(f.input);
    const execute = (binary: string, ...args: string[]) => execFileSync(SANDBOX_EXEC_PATH,
      ['-f', prepared.profilePath, binary, ...args], { env: prepared.env, encoding: 'utf8', stdio: 'pipe' });
    try {
      expect(execute('/bin/cat', f.config)).toBe(f.configText);
      for (const secret of [...f.secrets, join(f.input.codexHome, 'config.toml')]) {
        expect(() => execute('/bin/cat', secret), secret).toThrow();
      }
      expect(() => execute(process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "changed")', f.config)).toThrow();
      expect(() => execute(f.input.binary, '--version')).toThrow();
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(prepared.binary, prepared.args, { cwd: f.checkout, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => { if (code === 0) resolve(stdout); else reject(new Error(stderr)); });
      });
      expect(output).toBe(f.configText);
      expect(readFileSync(f.config, 'utf8')).toBe(f.configText);
    } finally { prepared.cleanup(); }
  });
});
