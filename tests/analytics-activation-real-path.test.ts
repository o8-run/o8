import { execFileSync, spawnSync } from 'node:child_process';
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
    ...['launch', 'startup'].flatMap((entry) => [false, true].map((existing) => ({ entry, existing }))),
    { entry: 'shutdown', existing: true },
  ])(
    'leaves analytics state untouched on opted-out $entry (existing directory: $existing)', async ({ entry, existing }) => {
      await choose(false);
      if (existing) {
        mkdirSync(analyticsDir, { recursive: true });
        writeFileSync(join(analyticsDir, 'sentinel'), 'unchanged');
        writeFileSync(join(analyticsDir, 'session-2147483647.json'), JSON.stringify({ pid: 2147483647, enabled: true }));
      }
      const child = spawnSync(process.execPath, [
        '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join, sep } from 'node:path';
        const load = async (path) => { const module = await import(path); return module.default ?? module; };
        const lifecycle = await load('./src/lib/analytics/session.ts');
        let route, NextRequest;
        if (process.env.O8_ANALYTICS_TEST_ENTRY === 'launch') {
          route = await load('./src/app/api/runtime/launch/route.ts');
          const { getRuntime } = await load('./src/lib/runtimes/index.ts');
          ({ NextRequest } = await import('next/server.js'));
          getRuntime('cloud').launch = async () => ({ ok: true, sessionKey: 'cloud:off-state-probe', note: 'Fixture launched.' });
        }
        const root = join(process.env.O8_DATA_DIR, 'usage-analytics');
        const accesses = [];
        let egress = 0;
        globalThis.fetch = async (url) => { if (String(url).endsWith('/v1/telemetry')) egress++; return Response.json({ ok: true }); };
        if (process.env.O8_ANALYTICS_TEST_ENTRY === 'shutdown') {
          const settings = await load('./src/app/api/panel/operator-defaults/route.ts');
          const choose = async (enabled) => settings.POST(new Request('http://localhost/api/panel/operator-defaults', {
            method: 'POST', body: JSON.stringify({ productTelemetryEnabled: enabled,
              crashReportsEnabled: false, telemetryConsentAnswered: true }),
          }));
          await choose(true);
          await lifecycle.startProductSession();
          await choose(false);
          egress = 0;
        }
        for (const api of [fs, fs.promises]) {
          for (const name of ['access', 'exists', 'stat', 'lstat', 'realpath', 'readdir', 'opendir', 'open', 'readFile', 'writeFile',
            'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'truncate', 'watch'].flatMap((name) => [name, name + 'Sync'])) {
            if (typeof api[name] !== 'function') continue;
            const original = api[name];
            api[name] = function (...args) {
              if (args.slice(0, 2).some((value) => typeof value === 'string' && (value === root || value.startsWith(root + sep)))) {
                accesses.push(name);
                throw new Error('Analytics state access while off.');
              }
              return original.apply(this, args);
            };
          }
        }
        syncBuiltinESMExports();
        let status = 200;
        if (route) {
          status = (await route.POST(new NextRequest('http://localhost/api/runtime/launch', {
            method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Fixture', cwd: process.env.O8_DATA_DIR,
              skipSetup: true, isolate: false, clientMutationId: 'off-state-probe-' + process.pid }),
          }))).status;
        } else if (process.env.O8_ANALYTICS_TEST_ENTRY === 'shutdown') {
          await lifecycle.endProductSession(true);
        } else {
          await lifecycle.startProductSession();
          await lifecycle.endProductSession(true);
        }
        console.log('OFF_STATE_PROBE:' + JSON.stringify({ status, accesses, egress }));
        process.exit(0);
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000, env: {
        PATH: process.env.PATH, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir,
        O8_ANALYTICS_TEST_ENTRY: entry,
      } });
      expect({ completed: child.status === 0 && !child.error }).toEqual({ completed: true });
      const result = JSON.parse(child.stdout.split('\n').find((line) => line.startsWith('OFF_STATE_PROBE:'))!.slice('OFF_STATE_PROBE:'.length));
      expect(result).toEqual({ status: 200, accesses: [], egress: 0 });
      expect(existsSync(analyticsDir)).toBe(existing);
      if (existing) expect(readFileSync(join(analyticsDir, 'sentinel'), 'utf8')).toBe('unchanged');
    },
  );

  it.each([false, true].flatMap((enabled) => ['regular', 'fifo', 'directory'].map((kind) => ({ enabled, kind }))))(
    'launches with analytics $enabled and a live $kind session marker without blocking', async ({ enabled, kind }) => {
      await choose(enabled);
      mkdirSync(analyticsDir, { recursive: true });
      const marker = join(analyticsDir, `session-${process.pid}.json`);
      if (kind === 'fifo') execFileSync('mkfifo', [marker]);
      else if (kind === 'directory') mkdirSync(marker);
      else writeFileSync(marker, JSON.stringify({ pid: process.pid, enabled: !enabled }));
      const child = spawnSync(process.execPath, [
        '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const load = async (path) => { const module = await import(path); return module.default ?? module; };
        const { POST } = await load('./src/app/api/runtime/launch/route.ts');
        const { getRuntime } = await load('./src/lib/runtimes/index.ts');
        const { NextRequest } = await import('next/server.js');
        getRuntime('cloud').launch = async () => ({ ok: true, sessionKey: 'cloud:marker-probe', note: 'Fixture launched.' });
        let egress = 0;
        globalThis.fetch = async (url) => { if (String(url).endsWith('/v1/telemetry')) egress++; return Response.json({ ok: true }); };
        let markerScans = 0;
        const readdir = fs.readdirSync;
        fs.readdirSync = function (path, ...args) {
          if (String(path) === join(process.env.O8_DATA_DIR, 'usage-analytics')) markerScans++;
          return readdir.call(this, path, ...args);
        };
        syncBuiltinESMExports();
        const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
          method: 'POST', body: JSON.stringify({ runtime: 'cloud', prompt: 'Fixture', cwd: process.env.O8_DATA_DIR,
            skipSetup: true, isolate: false, clientMutationId: 'marker-probe-' + process.pid }),
        }));
        console.log('MARKER_PROBE:' + JSON.stringify({ status: response.status, markerScans, egress }));
        process.exit(0);
      `], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000, env: {
        PATH: process.env.PATH, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir,
      } });
      // Keep arbitrary route diagnostics and request headers out of failure output.
      const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      expect({ completed: child.status === 0 && !child.error, timedOut }).toEqual({ completed: true, timedOut: false });
      const result = JSON.parse(child.stdout.split('\n').find((line) => line.startsWith('MARKER_PROBE:'))!.slice('MARKER_PROBE:'.length));
      expect(result.status).toBe(200);
      if (!enabled) expect(result).toMatchObject({ markerScans: 0, egress: 0 });
      if (enabled && kind === 'regular') expect(JSON.parse(readFileSync(marker, 'utf8')).enabled).toBe(true);
    },
  );

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
