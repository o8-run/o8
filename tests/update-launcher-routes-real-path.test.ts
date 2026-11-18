import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
const { getUpdateIdleWindow } = vi.hoisted(() => ({ getUpdateIdleWindow: vi.fn() }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow }));
vi.mock('@/lib/setup/cli-operation-admission', () => ({ inspectCliOperationAdmission: () => ({ blocked: false }), validRestartReservation: () => false }));
let server: Server;
let root: string;
let peers: Set<Socket>;
let ops: string[];
let status: Record<string, unknown>;
let silent = false;
const post = (body: object) => new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify(body) });
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('route did not answer promptly')), 3500); })]); }
  finally { clearTimeout(timer!); }
}
beforeEach(async () => {
  vi.resetModules();
  getUpdateIdleWindow.mockResolvedValue({ idle: true, idleExceptParked: true });
  root = await mkdtemp(join(tmpdir(), 'o8-up-'));
  vi.stubEnv('O8_LAUNCHER_SOCKET', join(root, 'launcher.sock'));
  ops = []; peers = new Set(); silent = false;
  status = { ok: true, state: 'staged', current: '1.0.0', available: { version: '2.0.0', notes: 'Changes' }, error: null };
  server = createServer({ allowHalfOpen: true }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    let bytes = ''; peer.on('data', chunk => { bytes += chunk; });
    peer.on('end', () => { const { op } = JSON.parse(bytes); ops.push(op); if (!silent) peer.end(JSON.stringify(status) + '\n'); });
  });
  await new Promise<void>(resolve => server.listen(process.env.O8_LAUNCHER_SOCKET, resolve));
});
afterEach(async () => {
  for (const peer of peers) peer.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
it('reads held launcher state through both production GET routes without applying', async () => {
  const apply = await import('@/app/api/panel/update/apply/route');
  const state = await import('@/app/api/panel/app/update-state/route');
  for (const route of [apply, state]) {
    const response = await bounded(route.GET());
    expect(await response.json()).toMatchObject({ ok: true, state: { version: '2.0.0', updatePending: true, heldUpdate: { phase: 'ready' } } });
  }
  expect(ops).toEqual(['update-status', 'update-status']);
});
it('checkOnly preserves staged bytes and never requests apply', async () => {
  const route = await import('@/app/api/panel/update/apply/route');
  const response = await bounded(route.POST(post({ checkOnly: true })));
  expect(await response.json()).toMatchObject({ ok: true, requested: false, result: { code: 'check_available' } });
  expect(ops).toEqual(['update-status']);
});
it('checks through launcher and reports current without applying', async () => {
  status = { ok: true, state: 'current', current: '1.0.0', available: null };
  const route = await import('@/app/api/panel/update/apply/route');
  expect(await (await bounded(route.POST(post({ checkOnly: true })))).json()).toMatchObject({ result: { code: 'check_current' } });
  expect(ops).toEqual(['update-status', 'update-check']);
});
it('forwards only explicit apply to launcher', async () => {
  const route = await import('@/app/api/panel/update/apply/route');
  const response = await bounded(route.POST(post({})));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ ok: true, requested: true });
  expect(ops).toEqual(['update-status', 'update-apply']);
});
it.each(['missing', 'silent', 'malformed'])('returns stable unavailable for %s launcher', async mode => {
  if (mode === 'missing') vi.stubEnv('O8_LAUNCHER_SOCKET', join(root, 'missing.sock'));
  if (mode === 'silent') silent = true;
  if (mode === 'malformed') status = { unexpected: true };
  const route = await import('@/app/api/panel/update/apply/route');
  const response = await bounded(route.POST(post({ checkOnly: true })));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'launcher_updater_unavailable' } });
  expect(ops).not.toContain('update-apply');
});
it('refuses classic reports and scheduler admission under launcher ownership', async () => {
  const route = await import('@/app/api/panel/app/update-state/route');
  for (const body of [{ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() }, { autoApply: { action: 'admit' } }]) {
    expect((await route.POST(post(body))).status).toBe(409);
  }
  expect(ops).toEqual([]);
});

it('refuses live work even for force since the launcher grants no force override', async () => {
  getUpdateIdleWindow.mockResolvedValue({ idle: false, idleExceptParked: false });
  const route = await import('@/app/api/panel/update/apply/route');
  for (const body of [{}, { force: true }]) {
    const response = await bounded(route.POST(post(body)));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'update_apply_busy' } });
  }
  expect(ops).not.toContain('update-apply');
});
it('returns unavailable from both GET routes without falling back to classic state', async () => {
  vi.stubEnv('O8_LAUNCHER_SOCKET', join(root, 'missing.sock'));
  const apply = await import('@/app/api/panel/update/apply/route');
  const state = await import('@/app/api/panel/app/update-state/route');
  for (const route of [apply, state]) {
    const response = await bounded(route.GET());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'launcher_updater_unavailable' } });
  }
});
it('reports launcher check failure without sending apply', async () => {
  status = { ok: true, state: 'failed', error: 'Check failed', available: null };
  const route = await import('@/app/api/panel/update/apply/route');
  const response = await bounded(route.POST(post({})));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'update_check_failed' } });
  expect(ops).not.toContain('update-apply');
});
it('keeps the launcher restart-inspection endpoint reachable', async () => {
  const route = await import('@/app/api/panel/app/update-state/route');
  const response = await route.POST(post({ autoApply: { action: 'inspect-restart', reservationId: 'invalid' } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ allowed: false, error: { code: 'restart_reservation_invalid' } });
});
