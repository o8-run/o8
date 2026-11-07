import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// The read-only child boundary is proven through the REAL entry points: an actual child is spawned
// and we observe (a) that .provider-keys.lock is never created for a read-only, credential-less
// child, (b) that the environment scrub still strips credential names, O8_MASTER_KEY and credential
// values exactly as the locked path does, and (c) that a credential-bearing runtime context is
// refused. This is the slice that lets /api/review/last-turn and /api/orchestrator/packet-transcript
// move to the native transport without serializing on the provider-store lock.
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-readonly-child-'));

const { execFile, execFileReadOnly } = await import('./child-process');
const { providerSpawnEnvironment, internalBrokerEnvironment } = await import('./spawn-environment');
const { mutateProviderKey } = await import('./key-store');
const { materializationAwareExecFile } = await import('@/lib/worktree/materialization-execution');

const execFileAsync = promisify(execFile);
const execFileReadOnlyAsync = promisify(execFileReadOnly);
const lockPath = () => join(state.dir, '.provider-keys.lock');
const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))';

beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url'));
  writeFileSync(join(state.dir, '.env.local'), '');
  rmSync(lockPath(), { force: true });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });

it('the locked boundary creates the provider-store lock for an ordinary child', async () => {
  // Fail-before anchor: the SAME trivial child on the locked path DOES create .provider-keys.lock.
  await execFileAsync(process.execPath, ['-e', ''], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' } });
  expect(existsSync(lockPath())).toBe(true);
});

it('the read-only boundary never takes the provider-store lock', async () => {
  await execFileReadOnlyAsync(process.execPath, ['-e', ''], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' } });
  expect(existsSync(lockPath())).toBe(false);
});

it('the read-only boundary scrubs credential names, the master key and credential values', async () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-secret-value' });
  // mutateProviderKey writes the key store under the lock, so clear the lock it left and prove the
  // read-only spawn itself does not re-create it while still performing the full scrub.
  rmSync(lockPath(), { force: true });
  const { stdout } = await execFileReadOnlyAsync(process.execPath, ['-e', PRINT_ENV], {
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      GEMINI_API_KEY: 'fixture-secret-value',
      O8_MASTER_KEY: 'fixture-master-key',
      SMUGGLED: 'fixture-secret-value',
      HARMLESS: 'kept',
    },
  });
  const childEnv = JSON.parse(stdout) as Record<string, string>;
  expect(childEnv.GEMINI_API_KEY).toBeUndefined();
  expect(childEnv.O8_MASTER_KEY).toBeUndefined();
  expect(childEnv.SMUGGLED).toBeUndefined();
  expect(childEnv.HARMLESS).toBe('kept');
  expect(existsSync(lockPath())).toBe(false);
});

it('the read-only boundary refuses a credential-bearing runtime context', () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-secret-value' });
  const prepared = providerSpawnEnvironment({ GEMINI_API_KEY: 'fixture-secret-value' }, { runtimeId: 'gemini' });
  // The boundary validates synchronously (like its existing credential/billing guard), so the
  // refusal throws at the call rather than rejecting a promise.
  expect(() => execFileReadOnlyAsync(process.execPath, ['-e', ''], { env: prepared }))
    .toThrow(/credential-bearing runtime context/);
});

it('the read-only boundary refuses a broker-key context (master key would be re-added)', () => {
  // A broker env carries no runtimeId but refreshChildEnvironment re-adds O8_MASTER_KEY from it,
  // so the fail-closed guard must reject it too rather than spawn a read-only child holding it.
  const broker = internalBrokerEnvironment();
  expect(() => execFileReadOnlyAsync(process.execPath, ['-e', ''], { env: broker }))
    .toThrow(/credential-bearing runtime context/);
});

it('a read-only git read returns its result and takes no provider-store lock', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'o8-readonly-git-'));
  try {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    run(['init', '-q']);
    run(['config', 'user.email', 'fixture@example.invalid']);
    run(['config', 'user.name', 'fixture']);
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    run(['add', '.']);
    run(['commit', '-qm', 'base']);
    writeFileSync(join(repo, 'tracked.txt'), 'two\n');

    const { stdout } = await materializationAwareExecFile('git', ['diff', '--name-only'], { cwd: repo, readOnly: true });
    expect(stdout.trim()).toBe('tracked.txt');
    expect(existsSync(lockPath())).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
