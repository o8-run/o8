import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { workerOwnedStdinInvocation } from '@/lib/runtimes/shared/owned-session/staged-stdin';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

let root: string;
let parent: ChildProcess | undefined;
let run: OwnedSessionRecord['recentRuns'][number] | undefined;
let output = '';
const file = (name: string) => join(root, name);
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: ${output.slice(-3000)}`);
}
async function stopParent(signal: NodeJS.Signals) {
  if (!parent || parent.exitCode !== null || parent.signalCode !== null) return;
  const closed = once(parent, 'close');
  parent.kill(signal);
  await closed;
}
async function startParent(mode = 'read') {
  output = '';
  parent = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    'tests/fixtures/owned-stdin-parent.ts'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
      O8_STDIN_FIXTURE_ROOT: root, O8_STDIN_FIXTURE_MODE: mode, O8_STDIN_NODE: process.execPath,
      O8_STDIN_SESSION_ROOT: file('sessions'), O8_WORKER_SANDBOX: 'off', O8_CRASH_SURVIVABLE_WORKERS: '1' } });
  parent.stdout?.on('data', chunk => { output += String(chunk); });
  parent.stderr?.on('data', chunk => { output += String(chunk); });
  await once(parent, 'message');
}
async function request(action: string, surfaceId?: string): Promise<OwnedSessionRecord> {
  const response = once(parent!, 'message');
  parent!.send({ action, surfaceId });
  const [message] = await response as [{ session?: OwnedSessionRecord; error?: string }];
  if (!message.session) throw new Error(`${message.error}\n${output}`);
  return message.session;
}
function setup() {
  root = mkdtempSync(join(getDataDir(), 'owned-stdin-'));
  execFileSync('git', ['init', '-q', '-b', 'main', file('repo')]);
}
afterEach(async () => {
  await stopParent('SIGKILL');
  if (run?.pid) {
    try { process.kill(-run.pid, 'SIGKILL'); } catch { /* Owned fixture already exited. */ }
  }
  parent = undefined;
  run = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('worker-owned stdin across server shutdown', () => {
  it.each([
    ['mid-write', 'SIGTERM'], ['mid-write', 'SIGKILL'],
    ['after-write', 'SIGTERM'], ['after-write', 'SIGKILL'],
  ] as const)('survives %s parent %s with complete input and continued output', async (phase, signal) => {
    setup();
    await startParent();
    const session = await request('launch');
    run = session.recentRuns[0];
    await waitFor(() => existsSync(file('mid-write')), 'provider paused while input is buffered');
    const staged = readFileSync(run.stdinPath!);
    expect(Number(readFileSync(file('mid-write'), 'utf8'))).toBeLessThan(staged.length);
    const provider = JSON.parse(readFileSync(file('provider.json'), 'utf8'));
    expect(provider.stdinIsFile).toBe(false);
    expect(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(provider.pid)], { encoding: 'utf8' }).trim())).toBe(run.pid);
    if (phase === 'after-write') {
      writeFileSync(file('continue'), 'read');
      await waitFor(() => existsSync(file('received.json')), 'provider received EOF');
    }
    await stopParent(signal);
    expect(() => process.kill(run!.pid, 0)).not.toThrow();
    const tick = Number(readFileSync(file('heartbeat'), 'utf8'));
    writeFileSync(file('continue'), 'read');
    await waitFor(() => existsSync(file('received.json')) && Number(readFileSync(file('heartbeat'), 'utf8')) > tick,
      'provider keeps running without the server');
    expect(JSON.parse(readFileSync(file('received.json'), 'utf8'))).toEqual({
      bytes: staged.length, sha256: createHash('sha256').update(staged).digest('hex'),
    });
    writeFileSync(file('exit'), 'finish');
    await waitFor(() => { try { process.kill(run!.pid, 0); return false; } catch { return true; } }, 'worker finished');
    await startParent();
    expect((await request('inspect', session.surfaceId)).recentRuns[0].outcome).toBe('finished');
  }, 40_000);

  it('persists rejected input as failure even when the provider reports success', async () => {
    setup();
    await startParent('reject');
    const session = await request('launch');
    run = session.recentRuns[0];
    await waitFor(() => JSON.parse(readFileSync(join(session.sessionDir, 'session.json'), 'utf8')).recentRuns[0].childExit,
      'exit callback persisted input failure');
    const recorded = JSON.parse(readFileSync(join(session.sessionDir, 'session.json'), 'utf8')) as OwnedSessionRecord;
    expect(recorded.recentRuns[0]).toMatchObject({ outcome: 'failed', childExit: { code: 74 } });
    expect(readFileSync(run.stderrPath, 'utf8')).toContain('O8_STDIN_DELIVERY_FAILED:');
    await stopParent('SIGKILL');
    await startParent('reject');
    expect((await request('inspect', session.surfaceId)).recentRuns[0].outcome).toBe('failed');
  }, 40_000);

  it('refuses a truncated staged descriptor before starting the provider', async () => {
    setup();
    const stagedPath = file('input');
    writeFileSync(stagedPath, 'partial');
    const stdin = openSync(stagedPath, 'r');
    const invocation = workerOwnedStdinInvocation({ command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', file('started')] }, 1000);
    const child = spawn(invocation.command, invocation.args, { stdio: [stdin, 'ignore', 'pipe'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH } });
    closeSync(stdin);
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close');
    expect(code).toBe(74);
    expect(stderr).toContain('staged input was truncated');
    expect(existsSync(file('started'))).toBe(false);
  });
});
