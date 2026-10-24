import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import nextConfig from '../next.config';

const root = mkdtempSync(join(tmpdir(), 'o8-next-route-loading-'));
let child: ChildProcess | undefined;

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 3_000);
    await exited;
    clearTimeout(force);
  }
  rmSync(root, { recursive: true, force: true });
});

it('serves production health before importing unrelated routes, then loads them on demand', async () => {
  const marker = join(root, 'route-imported');
  const startupReceipt = join(root, 'route-preload-started');
  mkdirSync(join(root, 'app/api/health'), { recursive: true });
  mkdirSync(join(root, 'app/api/unrelated'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  // Use the shipped startup policy, with Next's normal production default for
  // every option not explicitly configured. No loader or route is mocked.
  writeFileSync(join(root, 'next.config.js'), `module.exports = ${JSON.stringify({
    experimental: nextConfig.experimental,
    typescript: { ignoreBuildErrors: true },
  })};`);
  writeFileSync(join(root, 'app/api/health/route.js'), `
    export const dynamic = 'force-dynamic';
    export function GET() { return Response.json({ ready: true }); }
  `);
  writeFileSync(join(root, 'app/api/unrelated/route.js'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(marker)}, 'imported\\n');
    export const dynamic = 'force-dynamic';
    export function GET() { return Response.json({ loaded: true }); }
  `);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=2048' };
  const cli = resolve('node_modules/next/dist/bin/next');
  execFileSync(process.execPath, [cli, 'build', '--webpack'], {
    cwd: root, env, stdio: 'pipe', timeout: 90_000,
  });
  rmSync(marker, { force: true });
  const observer = join(root, 'observe-startup.cjs');
  writeFileSync(observer, `
    const { appendFileSync } = require('node:fs');
    const NextServer = require(${JSON.stringify(resolve('node_modules/next/dist/server/next-server.js'))}).default;
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (name, ...args) {
      if (name === 'caniuse-lite' || name.startsWith('caniuse-lite/')) throw new Error('Build-only dependency requested at runtime');
      return load.call(this, name, ...args);
    };
    const preload = NextServer.prototype.unstable_preloadEntries;
    NextServer.prototype.unstable_preloadEntries = function (...args) {
      appendFileSync(${JSON.stringify(startupReceipt)}, 'started\\n');
      return preload.apply(this, args);
    };
  `);
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  let diagnostic = '';
  child = spawn(process.execPath, ['--require', observer, cli, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    diagnostic = (diagnostic + String(chunk)).slice(-2_000);
  });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
      healthy = response.ok && (await response.json()).ready === true;
      if (healthy) break;
    } catch { /* production listener is starting */ }
    await new Promise(done => setTimeout(done, 25));
  }
  expect(healthy, diagnostic).toBe(true);
  // Observe the real constructor instead of racing a background preload's
  // eventual imports against the health response on fast fixtures.
  const startupReceipts = existsSync(startupReceipt) ? readFileSync(startupReceipt, 'utf8').trim().split('\n') : [];
  expect(startupReceipts, 'unrequested route preloading must not start during production boot').toHaveLength(0);
  expect(existsSync(marker), 'unrequested routes must stay outside the launch critical path').toBe(false);
  const response = await fetch(`http://127.0.0.1:${port}/api/unrelated`);
  expect(await response.json()).toEqual({ loaded: true });
  expect(readFileSync(marker, 'utf8')).toBe('imported\n');
  expect(nextConfig.outputFileTracingExcludes?.['*']).toContain('**/node_modules/caniuse-lite/**/*');
}, 120_000);
