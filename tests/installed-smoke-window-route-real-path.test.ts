import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/panel/installed-smoke/window/route';

const root = mkdtempSync(join(tmpdir(), 'o8-smoke-window-'));
const runId = randomUUID();
function request(id = runId) {
  return new Request('http://127.0.0.1/api/panel/installed-smoke/window', { method: 'POST',
    body: JSON.stringify({ ready: true, version: '0.1.900', runId: id }) });
}
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('records only the current isolated native window and stays unavailable in the daily instance', async () => {
  vi.stubEnv('O8_DATA_DIR', root);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  vi.stubEnv('O8_INSTALLED_SMOKE_RUN', runId);
  vi.stubEnv('O8_PRESHIP_GATE', '0');
  vi.stubEnv('O8_FORCE_BUNDLED_SERVERS', '1');
  expect((await POST(request())).status).toBe(404);
  expect(existsSync(join(root, 'installed-smoke-window.json'))).toBe(false);
  vi.stubEnv('O8_PRESHIP_GATE', '1');
  expect((await POST(request(randomUUID()))).status).toBe(400);
  expect(existsSync(join(root, 'installed-smoke-window.json'))).toBe(false);
  expect((await POST(request())).status).toBe(200);
  expect(JSON.parse(readFileSync(join(root, 'installed-smoke-window.json'), 'utf8'))).toEqual({ runId, ready: true, version: '0.1.900' });
});
