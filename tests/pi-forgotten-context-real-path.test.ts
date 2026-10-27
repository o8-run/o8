import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ start: vi.fn(() => { throw new Error('Provider must stay stopped'); }) }));
vi.mock('@/lib/app-update/work-launch-admission', async original => ({
  ...await original<typeof import('@/lib/app-update/work-launch-admission')>(), spawnWithWorkAdmission: provider.start,
}));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: '/fixture/pi' }) }));
vi.mock('@/lib/pi/sdk/session', () => ({ createPiSdkSession: provider.start }));
const root = mkdtempSync(join(tmpdir(), 'o8-pi-forget-'));
let external: typeof import('@/lib/pi/owned');
let builtin: typeof import('@/lib/pi-builtin/owned');
let db: typeof import('@/lib/db');
beforeAll(async () => {
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'memory.db'));
  vi.stubEnv('O8_OWNED_PI_ROOT', join(root, 'external'));
  vi.stubEnv('O8_OWNED_PI_BUILTIN_ROOT', join(root, 'builtin'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network in memory fixture'); }));
  db = await import('@/lib/db');
  const { advanceMemoryRevision } = await import('@/lib/cortex/memory-revision');
  advanceMemoryRevision(db.getSqlite());
  external = await import('@/lib/pi/owned');
  builtin = await import('@/lib/pi-builtin/owned');
}, 120_000);
afterAll(() => { db?.closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

it.each(['external', 'builtin'] as const)('holds pre-forget packet history before %s Pi resume or steer', async kind => {
  const sessionDir = join(root, kind, 'old-session');
  mkdirSync(sessionDir, { recursive: true });
  const surfaceId = `${kind === 'external' ? 'pi-owned' : 'pi-builtin-owned'}:old-session`;
  const file = join(sessionDir, 'session.json');
  const original = JSON.stringify({ surfaceId, sessionDir, packetId: 'packet-memory', cwd: root, repoPath: root,
    title: 'Old packet', latestPrompt: 'forgotten choice', latestSummary: 'old', model: 'fixture', recentRuns: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  writeFileSync(file, original);
  provider.start.mockClear();
  const result = kind === 'external'
    ? await external.steerOwnedPiSession(surfaceId, 'Continue').catch(error => ({ ok: false, note: String(error) }))
    : await builtin.resumeOwnedPiBuiltinSession(surfaceId, 'Continue');
  expect(result.ok).toBe(false);
  expect(result.note).toContain('fresh dispatch');
  expect(provider.start).not.toHaveBeenCalled();
  expect(readFileSync(file, 'utf8')).toBe(original);
});
