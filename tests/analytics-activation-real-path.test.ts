import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const runProbe = (mode: string, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    const started = performance.now();
    let ready = false;
    let active = false;
    let completed = 0;
    let budgetMs = 0;
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
      'tests/fixtures/analytics-state-probe.mjs', mode,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore', 'ipc'], env: {
      PATH: process.env.PATH, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir,
    } });
    const fail = (message: string) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(message));
    };
    const abort = () => fail('Analytics probe cancelled by its test.');
    signal.addEventListener('abort', abort, { once: true });
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.on('message', (message: { type?: string }) => {
      if (message.type === 'ready' && !ready) {
        ready = true;
        // Imports and cold transforms are outside the operation budget. Calibrate
        // the blocking guard to this child's observed startup on the current host.
        budgetMs = Math.max(1000, Math.ceil((performance.now() - started) * 3));
        child.send({ type: 'run' }, error => { if (error) fail('Analytics probe could not acknowledge readiness.'); });
      } else if (message.type === 'case_started' && ready && !active) {
        active = true;
        timer = setTimeout(() => fail('Analytics marker operation exceeded its calibrated budget.'), budgetMs);
      } else if (message.type === 'case_completed' && active) {
        clearTimeout(timer);
        active = false;
        completed++;
      } else fail('Analytics probe sent an invalid readiness sequence.');
    });
    child.once('error', () => fail('Analytics probe could not start.'));
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // Never include arbitrary route diagnostics or request headers in a red tail.
      if (code !== 0 || !ready || active || completed !== (mode === 'off' ? 5 : 6)) {
        reject(new Error('Analytics probe did not complete its readiness sequence.')); return;
      }
      const line = output.split('\n').find(line => line.startsWith('ANALYTICS_STATE_PROBE:'));
      if (!line) { reject(new Error('Analytics probe result is missing.')); return; }
      try { resolve(JSON.parse(line.slice('ANALYTICS_STATE_PROBE:'.length))); }
      catch { reject(new Error('Analytics probe result is invalid.')); }
    });
    if (signal.aborted) abort();
  });

  it('leaves analytics state untouched on opted-out launch, startup and shutdown', async ({ signal }) => {
    const cases = [
      ...['launch', 'startup'].flatMap((entry) => [false, true].map((existing) => ({ entry, existing }))),
      { entry: 'shutdown', existing: true },
    ];
    expect(await runProbe('off', signal)).toEqual(cases.map((item) => ({
      ...item, status: 200, accesses: [], egress: 0, unchanged: true,
    })));
  });

  it('launches with every live regular, FIFO and directory marker without blocking', async ({ signal }) => {
    const results = await runProbe('markers', signal) as Array<{ enabled: boolean; kind: string; status: number; markerScans: number; egress: number; regularUpdated: boolean | null }>;
    expect(results.map(({ enabled, kind }: { enabled: boolean; kind: string }) => ({ enabled, kind })))
      .toEqual([false, true].flatMap((enabled) => ['regular', 'fifo', 'directory'].map((kind) => ({ enabled, kind }))));
    for (const result of results) {
      expect(result.status).toBe(200);
      if (!result.enabled) expect(result).toMatchObject({ markerScans: 0, egress: 0 });
      else expect(result.markerScans).toBeGreaterThan(0);
      if (result.enabled && result.kind === 'regular') expect(result.regularUpdated).toBe(true);
    }
  });

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

  it('leaves no off milestone and counts a later enabled launch only once', async () => {
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
    expect(existsSync(join(analyticsDir, 'worker.first_launched'))).toBe(false);
    await choose(true);
    expect(payloads()).toHaveLength(0);
    expect((await launchWorker(request())).status).toBe(200);
    expect(payloads()).toEqual([{ event: 'worker.first_launched' }]);
    expect((await launchWorker(request())).status).toBe(200);
    expect(payloads()).toEqual([{ event: 'worker.first_launched' }]);
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
    expect(existsSync(analyticsDir)).toBe(false);
    await choose(null, true);
    execFileSync(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval',
      "globalThis.fetch = async () => Response.json({ ok: true }); const imported = await import('./src/lib/analytics/server.ts'); await (imported.default ?? imported).emitProductEvent('app.opened');",
    ], { cwd: process.cwd(), timeout: 10_000, stdio: 'ignore', env: {
      PATH: process.env.PATH, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir,
    } });
    expect(existsSync(marker)).toBe(false);
    await lifecycle.endProductSession(true);
    expect(payloads()).toEqual([{ event: 'session.ended', props: { clean: true } }]);
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
