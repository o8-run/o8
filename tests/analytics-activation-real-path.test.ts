import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as saveDefaults } from '@/app/api/panel/operator-defaults/route';
import { POST as postTelemetry } from '@/app/api/panel/telemetry/route';
import { POST as launchWorker } from '@/app/api/runtime/launch/route';
import * as runtimes from '@/lib/runtimes';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const analyticsDir = join(dataDir, 'usage-analytics');
const egress = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ ok: true }));
let sequence = 0;
const payloads = () => egress.mock.calls.filter(([url]) => String(url).endsWith('/v1/telemetry'))
  .map(([, init]) => JSON.parse(String(init?.body)));
async function choose(enabled: boolean | null, answered = true) {
  const response = await saveDefaults(new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST', body: JSON.stringify({ productTelemetryEnabled: enabled,
      crashReportsEnabled: false, telemetryConsentAnswered: answered }),
  }));
  expect(response.status).toBe(200);
}
const post = (body: unknown) => postTelemetry(new Request('http://localhost/api/panel/telemetry', {
  method: 'POST', body: JSON.stringify(body),
}));

beforeEach(async () => {
  rmSync(analyticsDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'fixture-usage-entitlement' }));
  await choose(true);
  egress.mockClear();
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v1/telemetry')) {
      return egress(url, { method: init?.method, body: init?.body });
    }
    return Response.json({ ok: true });
  });
});
afterEach(async () => {
  await choose(false);
  const lifecycle = await import('@/lib/analytics/session');
  await lifecycle.endProductSession(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('activation analytics through real routes and persisted state', () => {
  it.each([
    { event: 'worker.first_launched' },
    { event: 'merge.first_completed' },
    { event: 'session.ended', props: { clean: true } },
    { event: 'session.ended', props: { clean: false } },
  ])('sanitizes $event and sends nothing after persisted opt-out', async (payload) => {
    const extra = { ...payload, props: { ...payload.props, content: 'excluded', path: 'excluded',
      repository: 'excluded', prompt: 'excluded', identity: 'excluded', installId: 'excluded' } };
    const on = await post(extra);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, emitted: true });
    expect(payloads()).toEqual([payload]);
    await choose(false);
    egress.mockClear();
    expect(await (await post(extra)).json()).toEqual({ ok: true, emitted: false });
    expect(egress).not.toHaveBeenCalled();
  });

  it('rejects missing and malformed session outcomes through the route', async () => {
    for (const props of [undefined, {}, { clean: 'true' }, { clean: 0 }]) {
      expect((await post({ event: 'session.ended', props })).status).toBe(400);
    }
    expect(egress).not.toHaveBeenCalled();
  });

  it('counts the first successful worker launch once across module reloads, without content', async () => {
    const adapter = runtimes.getRuntime('cloud')!;
    vi.spyOn(adapter, 'launch').mockImplementation(async () => ({
      ok: true, sessionKey: `cloud:activation-${++sequence}`, note: 'Fixture worker launched.',
    }));
    const request = () => new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Excluded fixture content',
        cwd: dataDir, skipSetup: true, isolate: false, clientMutationId: `activation-${++sequence}` }),
    });
    expect((await launchWorker(request())).status).toBe(200);
    expect(payloads()).toContainEqual({ event: 'worker.first_launched' });
    expect(existsSync(join(analyticsDir, 'worker.first_launched'))).toBe(true);
    vi.resetModules();
    const freshRoute = await import('@/app/api/runtime/launch/route');
    const freshRuntime = await import('@/lib/runtimes');
    vi.spyOn(freshRuntime.getRuntime('cloud')!, 'launch').mockImplementation(async () => ({
      ok: true, sessionKey: `cloud:activation-${++sequence}`, note: 'Fixture worker launched.',
    }));
    expect((await freshRoute.POST(request())).status).toBe(200);
    expect(payloads().filter((item) => item.event === 'worker.first_launched')).toHaveLength(1);
    await choose(false);
    egress.mockClear();
    expect((await freshRoute.POST(request())).status).toBe(200);
    expect(payloads()).toHaveLength(0);
  });

  it('does not claim activation for a refused worker launch', async () => {
    vi.spyOn(runtimes.getRuntime('cloud')!, 'launch').mockResolvedValue({
      ok: false, sideEffect: 'none', note: 'Fixture launch refused.',
    });
    const response = await launchWorker(new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Excluded fixture content',
        cwd: dataDir, skipSetup: true, isolate: false, clientMutationId: `activation-${++sequence}` }),
    }));
    expect((await response.json()).ok).toBe(false);
    expect(existsSync(join(analyticsDir, 'worker.first_launched'))).toBe(false);
    expect(egress).not.toHaveBeenCalled();
  });

  it('does not replay a first worker launch that happened while opted out', async () => {
    const adapter = runtimes.getRuntime('cloud')!;
    vi.spyOn(adapter, 'launch').mockImplementation(async () => ({
      ok: true, sessionKey: `cloud:activation-${++sequence}`, note: 'Fixture worker launched.',
    }));
    const request = () => new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Excluded fixture content',
        cwd: dataDir, skipSetup: true, isolate: false, clientMutationId: `activation-${++sequence}` }),
    });
    await choose(false);
    expect((await launchWorker(request())).status).toBe(200);
    expect(payloads()).toHaveLength(0);
    expect(existsSync(join(analyticsDir, 'worker.first_launched'))).toBe(true);
    await choose(true);
    expect((await launchWorker(request())).status).toBe(200);
    expect(payloads()).toHaveLength(0);
  });

  it('keeps default-on sessions gated until the privacy screen is completed', async () => {
    const lifecycle = await import('@/lib/analytics/session');
    await choose(null, false);
    await lifecycle.startProductSession();
    await lifecycle.endProductSession(true);
    expect(egress).not.toHaveBeenCalled();
    await lifecycle.startProductSession();
    await choose(null, true);
    expect((await post({ event: 'app.opened' })).status).toBe(200);
    await lifecycle.endProductSession(true);
    expect(payloads()).toEqual([
      { event: 'app.opened' }, { event: 'session.ended', props: { clean: true } },
    ]);
  });

  it('opens the backend session gate when app.opened comes from another server process', async () => {
    const lifecycle = await import('@/lib/analytics/session');
    await choose(null, false);
    await lifecycle.startProductSession();
    const marker = join(analyticsDir, `session-${process.pid}.json`);
    expect(JSON.parse(readFileSync(marker, 'utf8')).enabled).toBe(false);
    await choose(null, true);
    execFileSync(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval',
      "globalThis.fetch = async () => Response.json({ ok: true }); const imported = await import('./src/lib/analytics/server.ts'); await (imported.default ?? imported).emitProductEvent('app.opened');",
    ], { cwd: process.cwd(), timeout: 10_000, stdio: 'ignore', env: {
      PATH: process.env.PATH, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir,
    } });
    expect(JSON.parse(readFileSync(marker, 'utf8')).enabled).toBe(true);
    await lifecycle.endProductSession(true);
  });

  it('leaves live siblings alone and fails closed on corrupt or ineligible recovery markers', async () => {
    const lifecycle = await import('@/lib/analytics/session');
    mkdirSync(analyticsDir, { recursive: true });
    writeFileSync(join(analyticsDir, 'session-2147483647.json'), '{invalid');
    writeFileSync(join(analyticsDir, `session-${process.ppid}.json`), JSON.stringify({ pid: process.ppid, enabled: true }));
    await lifecycle.startProductSession();
    expect(egress).not.toHaveBeenCalled();
    expect(existsSync(join(analyticsDir, `session-${process.ppid}.json`))).toBe(true);
    await choose(false);
    await lifecycle.endProductSession(true);
    writeFileSync(join(analyticsDir, 'session-2147483647.json'), JSON.stringify({ pid: 2147483647, enabled: false }));
    await choose(true);
    await lifecycle.startProductSession();
    expect(egress).not.toHaveBeenCalled();
    await choose(false);
    await lifecycle.endProductSession(true);
  });

  it('recovers an unclean backend session, records clean shutdown once, and respects opt-out', async () => {
    const lifecycle = await import('@/lib/analytics/session');
    mkdirSync(analyticsDir, { recursive: true });
    writeFileSync(join(analyticsDir, 'session-2147483647.json'), JSON.stringify({ pid: 2147483647, enabled: true }));
    await lifecycle.startProductSession();
    expect(payloads()).toEqual([{ event: 'session.ended', props: { clean: false } }]);
    expect(readdirSync(analyticsDir)).toContain(`session-${process.pid}.json`);
    await lifecycle.endProductSession(true);
    await lifecycle.endProductSession(true);
    expect(payloads()).toEqual([
      { event: 'session.ended', props: { clean: false } },
      { event: 'session.ended', props: { clean: true } },
    ]);
    await lifecycle.startProductSession();
    await choose(false);
    egress.mockClear();
    await lifecycle.endProductSession(false);
    writeFileSync(join(analyticsDir, 'session-2147483647.json'), JSON.stringify({ pid: 2147483647, enabled: true }));
    await lifecycle.startProductSession();
    await lifecycle.endProductSession(true);
    expect(egress).not.toHaveBeenCalled();
  });
});
