import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const binary = process.env.O8D_BINARY ?? process.env.O8D_TEST_BINARY
  ?? join(process.env.CARGO_TARGET_DIR ?? 'crates/o8d/target', 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
const PATHS = [['POST', '/api/panel/update/apply'], ['GET', '/api/panel/update/apply'],
  ['POST', '/api/panel/app/update-state'], ['GET', '/api/panel/app/update-state'], ['POST', '/api/panel/app/relaunch']];

it('keeps updater state in one process across both ports with Next stopped', async () => {
  if (!existsSync(binary)) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-updater-owner-')));
  const device = 'updater-owner-fixture-device-0123456789abcdef';
  const worker = 'updater-owner-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  // The packaged shell passes this to the WS process too: o8 next is the window.
  process.env.O8_NEXT_MAIN_WINDOW = '1';
  // A self-updatable install on every test host, as the in-process updater tests use.
  process.env.APPIMAGE = '/fixture/o8.AppImage';
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ o8d: true, binary, nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const call = (method: string, path: string, body?: object, headers: Record<string, string> = operator) =>
      fetch(origin + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

    // Only the operator may reach the updater: these routes carry no device,
    // worker or spectator grant, and the forward adds none.
    for (const [method, path] of PATHS) {
      expect((await call(method, path, method === 'POST' ? {} : undefined, {})).status, `${method} ${path}`).toBe(401);
      for (const token of [device, worker]) {
        expect((await call(method, path, method === 'POST' ? {} : undefined,
          { authorization: `Bearer ${token}`, 'content-type': 'application/json' })).status, `${method} ${path}`).toBe(403);
      }
    }

    // The desktop updater reports its check to the WS listener.
    expect((await call('POST', '/api/panel/app/update-state', { updatePending: true, version: '0.2.0',
      checkOutcome: 'available', checkedAt: new Date().toISOString() })).status).toBe(200);
    const clicked = await call('POST', '/api/panel/update/apply', { force: true });
    expect(clicked.status).toBe(202);
    expect(await clicked.json()).toMatchObject({ message: 'Update 0.2.0 apply request sent to the native updater.' });
    const requestedAt = (await (await call('GET', '/api/panel/update/apply')).json()).applyRequestedAt;
    expect(requestedAt).toEqual(expect.any(String));

    // A click through Next's route reaches the same state: it joins the request.
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_API_PORT: '1', O8_WS_PORT: new URL(origin).port });
    const next = {
      apply: await import('@/app/api/panel/update/apply/route'),
      state: await import('@/app/api/panel/app/update-state/route'),
    };
    const viaNext = (route: { GET?: unknown; POST?: unknown }, method: 'GET' | 'POST', path: string, body?: object) =>
      (route[method] as (request: Request) => Promise<Response>)(new Request(`http://127.0.0.1${path}`,
        { method, headers: operator, ...(body ? { body: JSON.stringify(body) } : {}) }));
    expect((await viaNext(next.apply, 'POST', '/api/panel/update/apply', { force: true })).status).toBe(202);
    const seen = await (await viaNext(next.state, 'GET', '/api/panel/app/update-state')).json();
    expect(seen).toMatchObject({ applyRequestedAt: requestedAt, state: { version: '0.2.0', updatePending: true } });

    // The native loop admits it; the next click while it installs is refused.
    expect(await (await call('POST', '/api/panel/app/update-state', { autoApply: { action: 'admit', attemptId: 'clicked' } })).json())
      .toMatchObject({ allowed: true });
    expect((await (await viaNext(next.apply, 'GET', '/api/panel/update/apply')).json()).applyRequestedAt).toBeNull();
    expect(await (await call('POST', '/api/panel/app/update-state', { autoApply: { action: 'install', attemptId: 'clicked' } })).json())
      .toMatchObject({ allowed: true });
    const again = await viaNext(next.apply, 'POST', '/api/panel/update/apply', {});
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'update_apply_in_progress' } });
    expect(await (await call('POST', '/api/panel/app/update-state', { autoApply: { action: 'restart', attemptId: 'clicked' } })).json())
      .toMatchObject({ allowed: true });

    // This process never held a copy of the state.
    const local = await import('@/lib/app-update/auto-apply');
    expect(local.getNativeApplyRequestTime()).toBeNull();
    expect((await import('@/lib/app-update/relaunch-state')).getAppUpdateState().version).toBeNull();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
