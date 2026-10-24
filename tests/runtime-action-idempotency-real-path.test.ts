import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { RuntimeActionRequest, RuntimeActionResult } from '@/lib/runtime/actions';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';

const h = vi.hoisted(() => ({
  perform: vi.fn<(request: RuntimeActionRequest) => Promise<RuntimeActionResult>>(async (request) => ({
    ok: true,
    action: request.action,
    surfaceId: request.surfaceId,
    sessionKey: request.surfaceId,
    runtime: 'codex',
    clientMutationId: request.clientMutationId,
    status: 'completed',
    note: 'Controlled once.',
  })),
  publish: vi.fn(async () => {}),
}));

vi.mock('@/lib/agent-control/service', () => ({
  performLegacyRuntimeActionViaAgentControl: h.perform,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: h.publish }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-runtime-action-idempotency-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/runtime/action/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb } = await import('@/lib/db');

function post(body: unknown) {
  return new NextRequest('http://localhost:3001/api/runtime/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('legacy runtime action persisted idempotency', () => {
  beforeEach(() => {
    h.perform.mockClear();
    h.publish.mockClear();
  });

  it('reports a known effort refusal and replays it after reopening the receipt database', async () => {
    h.perform.mockRejectedValueOnce(new EffortPinRejectionError('effort_coerced', 'The saved effort cannot be honored on this model.'));
    const body = { action: 'steer', surfaceId: 'codex-owned:effort-refusal', message: 'continue', clientMutationId: 'effort-refusal' };
    const response = await route.POST(post(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'effort_coerced', note: 'The saved effort cannot be honored on this model.' });
    closeDb();
    const replay = await route.POST(post(body));
    expect(replay.status).toBe(400);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('settles compiled CLI queued resume admission and replays its exact key after database reopen', async () => {
    execFileSync(process.execPath, [join(process.cwd(), 'cli/esbuild.config.mjs')], { stdio: 'pipe' });
    const token = 'runtime-action-cli-test-token';
    writeFileSync(join(dataDir, 'ws-token'), token);
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/api/setup/status') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ready: true }));
          return;
        }
        if (url.pathname !== '/api/runtime/action' || request.headers.authorization !== 'Bearer ' + token) {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'Unknown or unauthenticated fixture route.' }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await route.POST(post(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(await result.text());
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener address unavailable.');
    const cli = (message: string, equalsKey = false) => new Promise<{
      exitCode: number | null; stdout: string; stderr: string;
    }>((resolve, reject) => {
      const key = 'runtime-queued-cli-key';
      const child = spawn(process.execPath, [join(process.cwd(), 'cli/dist/o8.mjs'),
        'session', 'resume', 'codex-owned:queued-cli', '--message', message,
        ...(equalsKey ? ['--idempotency-key=' + key] : ['--idempotency-key', key]),
      ], {
        env: { ...process.env, O8_API_PORT: String(address.port), O8_API_TOKEN: token,
          O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Compiled CLI did not settle the admitted queued receipt.'));
      }, 10_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timeout); resolve({ exitCode, stdout, stderr }); });
    });
    h.perform.mockImplementation(async (request) => ({
      ok: true, action: request.action, surfaceId: request.surfaceId,
      sessionKey: request.surfaceId, runtime: 'codex', clientMutationId: request.clientMutationId,
      status: 'queued', note: 'Queued one background turn; its task is still unfinished.',
    }));
    try {
      const first = await cli('Continue unfinished work.');
      expect(first.exitCode, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        schema: 'o8/cli/session.resume/v1', ok: true, status: 'queued',
        clientMutationId: 'runtime-queued-cli-key',
      });
      expect(h.perform).toHaveBeenCalledTimes(1);
      closeDb();
      const replay = await cli('Continue unfinished work.', true);
      expect(replay.exitCode, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, status: 'queued', replayed: true });
      const conflict = await cli('A different unfinished task.');
      expect(conflict.exitCode).not.toBe(0);
      expect(h.perform).toHaveBeenCalledTimes(1);
      expect(h.publish).toHaveBeenCalledTimes(1);
    } finally {
      h.perform.mockImplementation(async (request) => ({
        ok: true, action: request.action, surfaceId: request.surfaceId,
        sessionKey: request.surfaceId, runtime: 'codex', clientMutationId: request.clientMutationId,
        status: 'completed', note: 'Controlled once.',
      }));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it('requires caller correlation before running a mutation', async () => {
    const response = await route.POST(post({
      action: 'interrupt',
      surfaceId: 'codex-owned:missing-correlation',
    }));

    expect(response.status).toBe(400);
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('returns JSON when persisted mutation binding throws', async () => {
    const bind = vi.spyOn(idempotency, 'bindIdempotencyClientMutation').mockImplementationOnce(() => {
      throw new Error('runtime idempotency write failed');
    });
    try {
      const response = await route.POST(post({
        action: 'interrupt',
        surfaceId: 'codex-owned:binding-failure',
        clientMutationId: 'runtime-binding-failure',
      }));

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ error: 'Unable to perform runtime action' }); // #3434 hides raw text
      expect(h.perform).not.toHaveBeenCalled();
    } finally {
      bind.mockRestore();
    }
  });

  it('replays an identical completed request without running or publishing twice', async () => {
    const body = {
      action: 'steer',
      surfaceId: 'codex-owned:replay',
      clientMutationId: 'runtime-action-replay-once',
      message: 'Continue with the focused test.',
    };

    const first = await route.POST(post(body));
    closeDb();
    const replay = await route.POST(post(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      clientMutationId: body.clientMutationId,
      replayed: true,
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('persists and replays an unavailable terminal result without repeating the action', async () => {
    h.perform.mockResolvedValueOnce({
      ok: false,
      action: 'interrupt',
      surfaceId: 'codex-owned:terminal-unavailable',
      sessionKey: 'codex-owned:terminal-unavailable',
      runtime: 'codex',
      clientMutationId: 'runtime-action-terminal-unavailable',
      status: 'unavailable',
      note: 'The process stop could not be confirmed.',
    });
    const body = {
      action: 'interrupt' as const,
      surfaceId: 'codex-owned:terminal-unavailable',
      clientMutationId: 'runtime-action-terminal-unavailable',
    };

    const first = await route.POST(post(body));
    closeDb();
    const replay = await route.POST(post(body));

    expect(first.status).toBe(400);
    expect(replay.status).toBe(400);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      note: 'The process stop could not be confirmed.',
    });
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      replayed: true,
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('holds an ambiguous thrown action as outcome unknown instead of executing it twice', async () => {
    h.perform.mockRejectedValueOnce(new Error('transport ended after dispatch'));
    const body = {
      action: 'interrupt' as const,
      surfaceId: 'codex-owned:outcome-unknown',
      clientMutationId: 'runtime-action-outcome-unknown',
    };

    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('outcome is unknown'),
      clientMutationId: body.clientMutationId,
      status: 'unavailable',
      outcomeUnknown: true,
      retryable: false,
      replayed: true,
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('returns an in-progress receipt when the first identical action is still running', async () => {
    let complete: ((result: RuntimeActionResult) => void) | undefined;
    h.perform.mockImplementationOnce((request) => new Promise((resolve) => {
      complete = resolve;
      expect(request.clientMutationId).toBe('runtime-action-in-flight');
    }));
    const body = {
      action: 'interrupt',
      surfaceId: 'codex-owned:in-flight',
      clientMutationId: 'runtime-action-in-flight',
    };

    const firstPromise = route.POST(post(body));
    await vi.waitFor(() => expect(h.perform).toHaveBeenCalledTimes(1));
    const duplicate = await route.POST(post(body));

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      action: 'interrupt',
      surfaceId: body.surfaceId,
      runtime: 'codex',
      clientMutationId: body.clientMutationId,
      deduped: true,
      status: 'queued',
      inProgress: true,
    });
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();

    complete?.({
      ok: true,
      action: 'interrupt',
      surfaceId: body.surfaceId,
      sessionKey: body.surfaceId,
      runtime: 'codex',
      clientMutationId: body.clientMutationId,
      status: 'completed',
      note: 'Interrupted once.',
    });
    expect((await firstPromise).status).toBe(200);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects mutation id reuse with changed input', async () => {
    const body = {
      action: 'steer',
      surfaceId: 'codex-owned:conflict',
      clientMutationId: 'runtime-action-conflict',
      message: 'First message.',
    };

    expect((await route.POST(post(body))).status).toBe(200);
    const conflict = await route.POST(post({ ...body, message: 'Changed message.' }));

    expect(conflict.status).toBe(409);
    expect(h.perform).toHaveBeenCalledTimes(1);
  });

  it('allows intentional repeated actions with distinct mutation ids', async () => {
    const base = {
      action: 'interrupt',
      surfaceId: 'codex-owned:intentional-repeat',
    };

    expect((await route.POST(post({ ...base, clientMutationId: 'runtime-interrupt-1' }))).status).toBe(200);
    expect((await route.POST(post({ ...base, clientMutationId: 'runtime-interrupt-2' }))).status).toBe(200);
    expect(h.perform).toHaveBeenCalledTimes(2);
  });
});
