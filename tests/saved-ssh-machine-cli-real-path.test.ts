import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const dir = mkdtempSync(join(tmpdir(), 'o8-saved-ssh-machine-'));
const cli = join(dir, 'o8.mjs');
const ssh = join(dir, 'ssh');
const remote = join(dir, 'remote o8');
const marker = join(dir, 'injection-marker');

function run(args: string[], input?: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      O8_DATA_DIR: dir,
      O8_API_TOKEN: 'local-operator-test-token',
      ...overrides,
    },
    input,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

beforeAll(async () => {
  writeFileSync(join(dir, 'ws-token'), 'local-operator-test-token\n', { mode: 0o600 });
  await build({
    entryPoints: ['cli/src/index.ts'],
    alias: cliBundleAlias,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: cli,
    banner: { js: 'import { createRequire as __o8_createRequire } from "node:module"; globalThis.require = __o8_createRequire(import.meta.url);' },
    define: { __O8_CLI_VERSION__: '"test"' },
  });
  writeFileSync(ssh, `#!/bin/sh
for argument in "$@"; do last="$argument"; done
case " $* " in *downhost*) echo 'offline' >&2; exit 255;; esac
case " $* " in *emptyhost*) exit 0;; esac
case " $* " in *--human*) case " $* " in *' -tt '*) :;; *) echo 'missing remote PTY' >&2; exit 44;; esac;; esac
exec /bin/sh -c "$last"
`);
  writeFileSync(remote, `#!/bin/sh
case "$2" in
  list) echo '{"schema":"o8/cli/terminal.list/v1","sessions":[{"id":"session-a"}]}' ;;
  show) echo '{"schema":"o8/cli/terminal.show/v1","text":"remote-only","session":{"id":"session-a"}}' ;;
  wait) case "$*" in *NEVER*) echo '{"schema":"o8/cli/error/v1","error":{"code":"wait_timeout","message":"Remote wait timed out."}}' >&2; exit 5;; esac; echo '{"schema":"o8/cli/terminal.wait/v1","id":"session-a","match":"remote","line":"remote-match","source":"stream","waitedMs":1}' ;;
  control) case "$*" in
    *--human*) printf 'remote human ready\r\n'; IFS= read -r frame; printf 'remote-human:%s\n' "$frame" ;;
    *) echo '{"schema":"o8/cli/terminal.control/v1","event":"attached","id":"session-a"}'; read -r frame; echo '{"schema":"o8/cli/terminal.control/v1","event":"data","id":"session-a","text":"remote-reply"}' ;;
  esac ;;
  *) exit 4 ;;
esac
`);
  chmodSync(ssh, 0o700);
  chmodSync(remote, 0o700);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('saved SSH machine CLI through the bundled process and persisted catalog', () => {
  it('saves a usage-only host after a Node check, without requiring or routing a remote terminal', () => {
    expect(run(['machine', 'add', 'emptyhost', '--label', 'Empty usage', '--usage-only']).status).toBe(5);
    expect(existsSync(join(dir, 'ssh-machines.json'))).toBe(false);
    const added = run(['machine', 'add', 'goodhost', '--label', 'Usage', '--usage-only']);
    expect(added.status, added.stderr).toBe(0);
    const catalog = JSON.parse(readFileSync(join(dir, 'ssh-machines.json'), 'utf8'));
    expect(catalog.machines).toMatchObject([{ label: 'Usage', usageOnly: true }]);
    expect(run(['machine', 'check', 'Usage']).status).toBe(0);
    const terminal = run(['terminal', 'list', '--machine', 'Usage']);
    expect(terminal.status).toBe(5); expect(JSON.parse(terminal.stderr).error.code).toBe('machine_usage_only');
    expect(run(['machine', 'remove', 'Usage']).status).toBe(0);
    rmSync(join(dir, 'ssh-machines.json'));
  });
  it('verifies before saving, targets the remote terminal, and never falls back to Local', () => {
    expect(run(['machine', 'list'], undefined, { O8_API_TOKEN: 'invented' }).status).toBe(3);
    expect(run(['machine', 'list'], undefined, { O8_WORKER_TOKEN: 'worker-token' }).status).toBe(3);
    const offline = run(['machine', 'add', 'downhost', '--label', 'Offline', '--remote-cli', remote]);
    expect(offline.status).toBe(2);
    expect(existsSync(join(dir, 'ssh-machines.json'))).toBe(false);
    const empty = run(['machine', 'add', 'emptyhost', '--label', 'Empty', '--remote-cli', remote]);
    expect(empty.status).toBe(5);
    expect(existsSync(join(dir, 'ssh-machines.json'))).toBe(false);

    const added = run(['machine', 'add', 'goodhost', '--label', 'Build', '--remote-cli', remote]);
    expect(added.status).toBe(0);
    const catalog = JSON.parse(readFileSync(join(dir, 'ssh-machines.json'), 'utf8'));
    expect(catalog.machines).toMatchObject([{ label: 'Build', target: 'goodhost', enabled: true }]);

    const listed = run(['terminal', 'list', '--machine', 'Build']);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).sessions).toEqual([{ id: 'session-a' }]);
    const shown = run(['terminal', 'show', 'session-a', '--machine', 'Build']);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).text).toBe('remote-only');
    const waited = run(['terminal', 'wait', 'session-a', '--match', 'remote', '--machine', 'Build']);
    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout).line).toBe('remote-match');
    const humanWait = run(['--human', 'terminal', 'wait', 'session-a', '--match', 'remote', '--machine', 'Build']);
    expect(humanWait.status).toBe(0);
    expect(humanWait.stdout).toBe('remote-match\n');
    const remoteTimeout = run(['terminal', 'wait', 'session-a', '--match', 'NEVER', '--timeout', '100', '--machine', 'Build']);
    expect(remoteTimeout.status).toBe(5);
    expect(JSON.parse(remoteTimeout.stderr).error.code).toBe('wait_timeout');
    const controlled = run(['terminal', 'control', 'session-a', '--machine', 'Build'], '{"type":"input","data":"hello"}\n');
    expect(controlled.status).toBe(0);
    expect(controlled.stdout).toContain('remote-reply');
    const humanControl = run(['--human', 'terminal', 'control', 'session-a', '--machine', 'Build'], 'hello\n');
    expect(humanControl.status, humanControl.stderr).toBe(0);
    expect(humanControl.stdout).toContain('remote human ready\r\n');
    expect(humanControl.stdout).toContain('remote-human:hello');

    const malicious = run(['terminal', 'show', `session-a'; touch ${marker}; echo '`, '--machine', 'Build']);
    expect(malicious.status).toBe(0);
    expect(existsSync(marker)).toBe(false);

    expect(run(['machine', 'disable', 'Build']).status).toBe(0);
    const disabled = run(['terminal', 'list', '--machine', 'Build']);
    expect(disabled.status).toBe(5);
    expect(disabled.stdout).toBe('');
    expect(run(['machine', 'enable', 'Build']).status).toBe(0);
    expect(run(['machine', 'check', 'Build']).status).toBe(0);
    expect(run(['machine', 'remove', 'Build']).status).toBe(0);
    expect(run(['terminal', 'list', '--machine', 'Build']).status).toBe(4);
  });

  it('keeps simultaneous catalog writes and rejects normalized duplicate labels', async () => {
    const concurrentAdd = (label: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'machine', 'add', 'goodhost', '--label', label, '--remote-cli', remote], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, O8_DATA_DIR: dir, O8_API_TOKEN: 'local-operator-test-token' },
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });
    expect(await Promise.all([concurrentAdd('Alpha'), concurrentAdd('Beta')])).toEqual([0, 0]);
    const catalog = JSON.parse(readFileSync(join(dir, 'ssh-machines.json'), 'utf8'));
    expect(catalog.machines.map((machine: { label: string }) => machine.label).sort()).toEqual(['Alpha', 'Beta']);
    const rename = run(['machine', 'rename', 'Beta', '--label', 'Alpha ']);
    expect(rename.status).toBe(5);
  });
});
