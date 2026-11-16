import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ principal: vi.fn(), running: vi.fn() }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: h.principal }));
vi.mock('@/lib/panel/mobile-network', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/panel/mobile-network')>(), runningPhoneNetwork: h.running,
}));
import { GET, POST } from './route';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'o8-mobile-network-'));
  vi.stubEnv('O8_DATA_DIR', dir);
  vi.stubEnv('O8_PACKAGED_APP', '1');
  h.principal.mockReturnValue('operator');
  h.running.mockResolvedValue(false);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function request(peer: string | null, enabled = true) {
  return new Request('http://127.0.0.1/api/panel/mobile-network', { method: 'POST',
    headers: { ...(peer ? { 'x-o8-client-addr': peer } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }) });
}
it.each(['192.168.1.2', '::ffff:192.168.1.2', null])('refuses a non-loopback or unproven peer %s', async peer => {
  expect((await POST(request(peer))).status).toBe(403);
  expect((await GET(request(peer))).status).toBe(403);
  expect(() => readFileSync(join(dir, 'phone-network'))).toThrow();
});
it.each(['device', 'worker', 'anonymous', 'spectator'])('refuses the %s principal even on loopback', async role => {
  h.principal.mockReturnValue(role);
  expect((await POST(request('127.0.0.1'))).status).toBe(403);
});
it('persists owner-only choice while reporting actual listener state separately', async () => {
  expect(await (await GET(request('127.0.0.1'))).json()).toMatchObject({ enabled: false, running: false });
  expect(await (await POST(request('127.0.0.1'))).json()).toMatchObject({ enabled: true, running: false });
  expect(readFileSync(join(dir, 'phone-network'), 'utf8')).toBe('on\n');
  expect(statSync(join(dir, 'phone-network')).mode & 0o777).toBe(0o600);
  h.running.mockResolvedValue(true);
  expect(await (await GET(request('127.0.0.1'))).json()).toMatchObject({ enabled: true, running: true });
  expect(await (await POST(request('127.0.0.1', false))).json()).toMatchObject({ enabled: false, running: true });
  expect(readFileSync(join(dir, 'phone-network'), 'utf8')).toBe('off\n');
});

it('refuses unstamped development servers even with a claimed peer', async () => {
  vi.stubEnv('O8_PACKAGED_APP', '');
  expect((await POST(request('127.0.0.1'))).status).toBe(403);
});
