import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

// Regression guard for the Next (webpack) server build rewriting require.resolve('better-sqlite3')
// to a numeric module id, so the stamped child credential policy carried a non-path sqliteModule and
// the staged-stdin relay threw "Child credential policy is invalid". Claude Code hit it (its launch
// validates the stamp); Codex did not validate, so it ran with the same bad stamp unnoticed.
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-child-sqlite-'));

const { resolveChildSqliteModule, requireAbsoluteSqliteModule, childEnvironment, stampChildPolicy } =
  await import('./spawn-environment');
const { EMBEDDED_CHILD_POLICY_SCRIPT } = await import('./embedded-child-policy');

beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url'));
  writeFileSync(join(state.dir, '.env.local'), '');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });

describe('requireAbsoluteSqliteModule fails closed on a bundler-rewritten reference', () => {
  it('rejects the webpack numeric module id', () => {
    // 87550 is the literal id webpack substituted in the installed 0.1.816 bundle.
    expect(() => requireAbsoluteSqliteModule(87550)).toThrow(/absolute module path|rewritten/);
  });
  it('rejects a relative path', () => {
    expect(() => requireAbsoluteSqliteModule('better-sqlite3/lib/index.js')).toThrow(/absolute module path|rewritten/);
  });
  it('passes an absolute path through unchanged', () => {
    expect(requireAbsoluteSqliteModule('/abs/better-sqlite3/index.js')).toBe('/abs/better-sqlite3/index.js');
  });
});

it('resolveChildSqliteModule returns an absolute path to better-sqlite3', () => {
  const resolved = resolveChildSqliteModule();
  expect(typeof resolved).toBe('string');
  expect(isAbsolute(resolved as string)).toBe(true);
  expect(resolved).toContain('better-sqlite3');
});

it('the stamped policy carries an absolute sqliteModule the embedded child accepts', () => {
  const env = childEnvironment({ runtimeId: 'claude-code', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
  stampChildPolicy(env);
  const policy = JSON.parse(env.O8_CHILD_CREDENTIAL_POLICY) as { sqliteModule: unknown };
  expect(typeof policy.sqliteModule).toBe('string');
  expect(isAbsolute(policy.sqliteModule as string)).toBe(true);

  const script = `${EMBEDDED_CHILD_POLICY_SCRIPT}\ntry { withO8ChildPolicy(() => process.stdout.write('VALID'), {}); } catch (e) { process.stdout.write('THREW:' + e.message); }`;
  const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  expect(out).toBe('VALID');
});

it('a packaged layout with the addon only under prebuilds/ loads in the plain-Node child', () => {
  // The installed app ships better-sqlite3 without build/Release and redirects to prebuilds/ only
  // inside the server process. Every worker launch died in the child with "Could not locate the
  // bindings file" (0.1.820). This rebuilds that layout from the real module.
  const realRoot = dirname(dirname(resolveChildSqliteModule() as string));
  const packaged = join(state.dir, 'packaged', 'better-sqlite3');
  cpSync(join(realRoot, 'lib'), join(packaged, 'lib'), { recursive: true });
  cpSync(join(realRoot, 'package.json'), join(packaged, 'package.json'));
  const abiDir = join(packaged, 'prebuilds', `node-v${process.versions.modules}`, `${process.platform}-${process.arch}`);
  mkdirSync(abiDir, { recursive: true });
  cpSync(join(realRoot, 'build', 'Release', 'better_sqlite3.node'), join(abiDir, 'better_sqlite3.node'));

  const env = childEnvironment({ runtimeId: 'claude-code', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
  stampChildPolicy(env);
  const policy = JSON.parse(env.O8_CHILD_CREDENTIAL_POLICY!) as Record<string, unknown>;
  env.O8_CHILD_CREDENTIAL_POLICY = JSON.stringify({ ...policy, sqliteModule: join(packaged, 'lib', 'index.js') });

  const script = `${EMBEDDED_CHILD_POLICY_SCRIPT}\ntry { withO8ChildPolicy(() => process.stdout.write('VALID'), {}); } catch (e) { process.stdout.write('THREW:' + e.message.split('\\n')[0]); }`;
  const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  expect(out).toBe('VALID');
});
