import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as updateApplyRoute from '@/app/api/panel/update/apply/route';
import * as updateStateRoute from '@/app/api/panel/app/update-state/route';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-update-check-state-'));
const cliEntry = join(dataDir, 'o8.mjs');
const children = new Set<ChildProcess>();
let server: Server | null = null;
let apiPort = 0;
let emulateNativeCheck = false;
let nativeVersion: string | null = null;
let unavailableResponse = false;

function stateRequest(body: unknown) {
  return new Request('http://127.0.0.1/api/panel/app/update-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function forwardUpdateApply(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  if (unavailableResponse) return Response.json({ ok: false, requested: false,
    checkedAt: '2026-10-23T14:00:00.000Z', checkAgeMs: 25_000,
    error: { code: 'update_check_unavailable', message: 'Native check did not respond.', retryable: true, retryAfterMs: 5_000 } }, { status: 503 });
  const pending = updateApplyRoute.POST(new Request('http://127.0.0.1/api/panel/update/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));
  if (emulateNativeCheck) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const control = await (await updateStateRoute.GET()).json();
    expect(control.checkRequestedAt).toEqual(expect.any(String));
    await updateStateRoute.POST(stateRequest({ updatePending: Boolean(nativeVersion), checkOutcome: nativeVersion ? 'available' : 'failed',
      version: nativeVersion, checkedAt: new Date().toISOString(), checkError: nativeVersion ? null : 'synthetic native feed failure' }));
  }
  return pending;
}

async function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.O8_WORKER_TOKEN;
  delete env.O8_WORKER_PACKET_ID;
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: process.cwd(),
    env: {
      ...env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_API_TOKEN: 'synthetic-update-check-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  children.delete(child);
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

beforeAll(async () => {
  await build({
    entryPoints: [join(process.cwd(), 'cli/src/index.ts')],
    alias: cliBundleAlias,
    outfile: cliEntry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __O8_CLI_VERSION__: JSON.stringify('test-fixture') },
    banner: {
      js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url); globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);`,
    },
  });
  server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/setup/cli-updates?refresh=1') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ tools: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/panel/update/apply') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ currentVersion: '0.1.1' }));
      return;
    }
    if (request.url !== '/api/panel/update/apply' || request.method !== 'POST') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'missing fixture route' }));
      return;
    }
    const routeResponse = await forwardUpdateApply(request);
    response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers));
    response.end(Buffer.from(await routeResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('update CLI fixture did not bind');
  apiPort = address.port;
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('update check state through the real route and CLI parser', () => {
  it('preserves structured unavailable details through the built CLI', async () => {
    unavailableResponse = true;
    try {
      const result = await runCli(['update', 'check']);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'o8/cli/update.check/v1', ok: false,
        checkedAt: '2026-10-23T14:00:00.000Z', checkAgeMs: 25_000,
        error: { code: 'update_check_unavailable', retryable: true, retryAfterMs: 5_000 } });
    } finally { unavailableResponse = false; }
  });
  it('refreshes an absent check and keeps native failure distinct from current, including force', async () => {
    emulateNativeCheck = true;
    const result = await runCli(['update', 'apply']);
    emulateNativeCheck = false;
    expect(result.exitCode, result.stderr).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'update_check_failed' },
      check: { outcome: 'failed', checkedAt: expect.any(String) } });
    const forced = await runCli(['update', 'apply', '--force']);
    expect(forced.exitCode, forced.stderr).toBe(5);
    expect(JSON.parse(forced.stdout)).toMatchObject({ ok: false, error: { code: 'update_check_failed' } });
  });

  it('returns failed and current check outcomes as distinct route states', async () => {
    const checkedAt = new Date().toISOString();
    await updateStateRoute.POST(stateRequest({
      updatePending: false,
      checkOutcome: 'failed',
      checkedAt,
      checkError: 'synthetic feed timeout',
    }));

    const failedStateResponse = await updateStateRoute.GET();
    await expect(failedStateResponse.json()).resolves.toMatchObject({
      ok: true,
      state: {
        check: {
          outcome: 'failed',
          checkedAt,
          errorCode: 'update_check_failed',
          error: 'synthetic feed timeout',
        },
      },
    });

    const failedResult = await runCli(['update', 'apply']);
    expect(failedResult.exitCode, failedResult.stderr).toBe(5);
    expect(JSON.parse(failedResult.stdout)).toMatchObject({
      ok: false,
      requested: false,
      error: { code: 'update_check_failed' },
      check: { outcome: 'failed', errorCode: 'update_check_failed' },
    });

    await updateStateRoute.POST(stateRequest({
      updatePending: false,
      checkOutcome: 'current',
      checkedAt,
      checkError: null,
    }));
    const currentResult = await runCli(['update', 'apply']);
    expect(currentResult.exitCode, currentResult.stderr).toBe(0);
    expect(JSON.parse(currentResult.stdout)).toMatchObject({
      ok: true,
      requested: false,
      result: 'already_current',
      error: null,
      check: { outcome: 'current', errorCode: null },
    });

    await updateStateRoute.POST(stateRequest({
      updatePending: false,
      checkOutcome: 'never',
      checkedAt: null,
      checkError: null,
    }));
    const staleStateResponse = await updateStateRoute.GET();
    await expect(staleStateResponse.json()).resolves.toMatchObject({
      state: { check: { outcome: 'current', checkedAt } },
    });

    await updateStateRoute.POST(stateRequest({
      updatePending: false,
      checkOutcome: 'failed',
      checkedAt: new Date(Date.parse(checkedAt) - 1_000).toISOString(),
      checkError: 'stale synthetic failure',
    }));
    const olderStateResponse = await updateStateRoute.GET();
    await expect(olderStateResponse.json()).resolves.toMatchObject({
      state: { check: { outcome: 'current', checkedAt, error: null } },
    });
  });
  it('lets the built CLI request a fresh check while the last current result is recent', async () => {
    await updateStateRoute.POST(stateRequest({ updatePending: false, checkOutcome: 'current', checkedAt: new Date().toISOString() }));
    emulateNativeCheck = true; nativeVersion = '0.1.999';
    try {
      const result = await runCli(['update', 'check']);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'o8/cli/update.check/v1', requested: false,
        result: 'check_available', version: '0.1.999', checkAgeMs: expect.any(Number), check: { outcome: 'available' } });
    } finally { emulateNativeCheck = false; nativeVersion = null; }
  });
});
