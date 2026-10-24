import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { EMBEDDED_CHILD_POLICY_SCRIPT } from './embedded-child-policy';

const directories: string[] = [];
const children: ChildProcess[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'o8-embedded-policy-'));
  directories.push(directory);
  mkdirSync(join(directory, 'runtime-billing'));
  writeFileSync(join(directory, '.env.local'), 'OPENAI_API_KEY=current\n');
  writeFileSync(join(directory, 'runtime-billing/claude-code.json'), '{"mode":"api"}');
  const sha = (file: string) => createHash('sha256').update(readFileSync(join(directory, file))).digest('hex');
  writeFileSync(join(directory, 'provider-launch-policy.json'), '{"version":1,"epoch":"fixture"}');
  const stamp = JSON.stringify({ runtimeId: 'claude-code', directory, policyFile: join(directory, 'provider-launch-policy.json'), policyHash: sha('provider-launch-policy.json'), apiAllowed: true, approvedCredentials: { OPENAI_API_KEY: createHash('sha256').update('current').digest('hex') }, sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3') });
  return { directory, stamp, marker: join(directory, 'executed.json') };
}

async function delayed(input: ReturnType<typeof fixture>, env: Record<string, string | undefined>, beforeRun = () => {}) {
  const script = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const { spawnSync } = require('node:child_process');
process.stdin.once('data', () => {
  try {
    const result = withO8ChildPolicy(env => spawnSync(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({key:process.env.OPENAI_API_KEY,stamp:process.env.O8_CHILD_CREDENTIAL_POLICY,master:process.env.O8_MASTER_KEY}))", process.argv[1]], { env }));
    if (result.error || result.status !== 0) throw result.error || new Error('Child failed');
    process.stdout.write(JSON.stringify({ ok: true }) + '\n'); process.stdin.destroy();
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.stdin.destroy(); }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
`;
  const stat = lstatSync(input.directory);
  const invocation = guardedWorkspaceInvocation(process.execPath, ['-e', script, input.marker], {
    canonicalPath: realpathSync(input.directory), device: stat.dev, inode: stat.ino,
  });
  const child = spawn(invocation.command, invocation.args, { cwd: input.directory, env: { NODE_ENV: 'test', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    child.on('error', reject);
    let answered = false;
    let buffer = '';
    child.stdout!.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, newline)) as { ready?: boolean; ok: boolean; error?: string };
        buffer = buffer.slice(newline + 1);
        if (value.ready) { beforeRun(); child.stdin!.end('run\n'); }
        else { answered = true; resolve(value); }
      }
    });
    child.on('close', () => { if (!answered) resolve({ ok: false, error: stderr }); });
  });
  await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
  return result;
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('generated helper child creation after delayed IPC', () => {
  it.each(['store', 'billing'])('refuses changed %s policy before the actual nested spawn', async kind => {
    const input = fixture();
    const result = await delayed(input, { OPENAI_API_KEY: 'current', O8_CHILD_CREDENTIAL_POLICY: input.stamp }, () => {
      writeFileSync(join(input.directory, kind === 'store' ? '.env.local' : 'runtime-billing/claude-code.json'), kind === 'store' ? 'OPENAI_API_KEY=rotated\n' : '{"mode":"subscription"}');
      writeFileSync(join(input.directory, 'provider-launch-policy.json'), '{"version":1,"epoch":"changed"}');
    });
    expect(result.ok).toBe(false);
    expect(existsSync(input.marker)).toBe(false);
  });

  it('preserves the stamp to a helper, then removes stamp and master at actual execution', async () => {
    const input = fixture();
    expect((await delayed(input, { OPENAI_API_KEY: 'current', O8_CHILD_CREDENTIAL_POLICY: input.stamp, O8_MASTER_KEY: 'private-master' })).ok).toBe(true);
    expect(JSON.parse(readFileSync(input.marker, 'utf8'))).toEqual({ key: 'current' });
  });

  it.each(['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'COPILOT_PROVIDER_BEARER_TOKEN'])('refuses unstamped %s credentials', async name => {
    const input = fixture();
    expect((await delayed(input, { [name]: 'untrusted' })).ok).toBe(false);
    expect(existsSync(input.marker)).toBe(false);
  });

  it('allows an unstamped utility environment without provider credentials', async () => {
    const input = fixture();
    expect((await delayed(input, {})).ok).toBe(true);
    expect(JSON.parse(readFileSync(input.marker, 'utf8'))).toEqual({});
  });

  it('refuses a nested spawn while the shared SQLite lock is held', async () => {
    const input = fixture();
    const lock = new Database(join(input.directory, '.provider-keys.lock'));
    try {
      const result = await delayed(input, { OPENAI_API_KEY: 'current', O8_CHILD_CREDENTIAL_POLICY: input.stamp }, () => lock.exec('BEGIN EXCLUSIVE'));
      expect(result.ok).toBe(false);
      expect(existsSync(input.marker)).toBe(false);
    } finally { lock.close(); }
  });

  it.each([false, true])('revalidates policy after transient lock contention (changed=%s)', async changed => {
    const input = fixture();
    const lock = new Database(join(input.directory, '.provider-keys.lock'));
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await delayed(input, { OPENAI_API_KEY: 'current', O8_CHILD_CREDENTIAL_POLICY: input.stamp }, () => {
        lock.exec('BEGIN EXCLUSIVE');
        release = setTimeout(() => {
          if (changed) writeFileSync(join(input.directory, 'provider-launch-policy.json'), '{"version":1,"epoch":"changed"}');
          lock.close();
        }, 100);
      });
      expect(result.ok).toBe(!changed);
      expect(existsSync(input.marker)).toBe(!changed);
      if (changed) expect(result.error).toContain('Child credential policy changed');
    } finally {
      clearTimeout(release);
      if (lock.open) lock.close();
    }
  });
});
