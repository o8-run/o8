import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs'); const p = process.getBuiltinModule('node:path');
  return { root: fs.realpathSync.native(fs.mkdtempSync(p.join(process.getBuiltinModule('node:os').tmpdir(), 'o8-npx-registry-'))) };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => f.root, migrateDataDirOnce: () => {} }));
afterAll(() => rmSync(f.root, { recursive: true, force: true }));

it('still removes saved provider material renamed to an approved npm configuration key', async () => {
  vi.stubEnv('O8_MASTER_KEY', randomBytes(32).toString('base64url'));
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { execFileSync } = await import('@/lib/providers/child-process');
  const saved = randomBytes(24).toString('hex'); mutateProviderKey('OPENAI_API_KEY', { key: saved });
  vi.stubEnv('NPM_CONFIG_CACHE', saved);
  try {
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(String("NPM_CONFIG_CACHE" in process.env))'], { encoding: 'utf8' })).toBe('false');
  } finally { mutateProviderKey('OPENAI_API_KEY', { key: null }); vi.unstubAllEnvs(); }
});
