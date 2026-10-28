import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLaunchRequest, RuntimeLaunchResult } from '@/lib/runtime/actions';
import { RuntimeLaunchPostEffectError } from '@/lib/runtime/launch-governance';
import { MANUAL_THINKING_EFFORTS, THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';

const h = vi.hoisted(() => ({
  launch: vi.fn<(request: RuntimeLaunchRequest) => Promise<RuntimeLaunchResult>>(async (request) => ({
    ok: true,
    runtime: request.runtime,
    clientMutationId: request.clientMutationId,
    surfaceId: `surface-${request.clientMutationId}`,
    note: 'Runtime launched once.',
    cwd: request.cwd ?? '',
    repoPath: request.repoPath ?? request.cwd ?? '',
    worktree: null,
    laneId: request.existingLaneId ?? null,
  })),
  publish: vi.fn<(input: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...original, launchRuntimeSurface: h.launch };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: h.publish }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-runtime-launch-idempotency-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');
const codexHome = join(dataDir, 'codex-account');
mkdirSync(codexHome);
vi.stubEnv('CODEX_HOME', codexHome);
writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{
  slug: 'gpt-6.1-sol',
  supported_reasoning_levels: MANUAL_THINKING_EFFORTS.map(effort => ({ effort })),
}] }));
const codexIdentity = { id: 'codex-local-default', label: 'Current local sign-in', configHomeRef: codexHome };

const route = await import('@/app/api/runtime/launch/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb } = await import('@/lib/db');
const { getOperatorDefaults, updateOperatorDefaults } = await import('@/lib/operator/defaults');

function post(body: unknown) {
  return new NextRequest('http://localhost:3001/api/runtime/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function successfulResult(request: RuntimeLaunchRequest): RuntimeLaunchResult {
  return {
    ok: true,
    runtime: request.runtime,
    clientMutationId: request.clientMutationId,
    surfaceId: `surface-${request.clientMutationId}`,
    note: 'Runtime launched once.',
    cwd: request.cwd ?? '',
    repoPath: request.repoPath ?? request.cwd ?? '',
    worktree: null,
    laneId: request.existingLaneId ?? null,
  };
}

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runtime launch persisted idempotency through the real route', () => {
  beforeEach(() => {
    h.launch.mockReset();
    h.launch.mockImplementation(async (request) => successfulResult(request));
    h.publish.mockClear();
    idempotency.__resetIdempotencyStoreForTests();
  });

  it('requires caller correlation before launching a runtime', async () => {
    const response = await route.POST(post({
      runtime: 'codex',
      prompt: 'Launch without correlation.',
      cwd: dataDir,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('clientMutationId') });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(['turbo', '', 'HIGH', 1, false, null, {}, ['high']].map((effort) => [effort]))(
    'rejects malformed effort %j before binding the mutation identity', async (effort) => {
      const body = {
        runtime: 'codex', prompt: 'Inspect the fixture.', cwd: dataDir,
        clientMutationId: 'invalid-effort-correction', effort,
      };
      const response = await route.POST(post(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('effort'), code: 'invalid_effort',
      });
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();

      const corrected = { ...body, effort: 'high' };
      expect((await route.POST(post(corrected))).status).toBe(200);
      expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ effort: 'high' }), codexIdentity);
      closeDb();
      const replay = await route.POST(post(corrected));
      expect(replay.status).toBe(200);
      expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
      expect(h.launch).toHaveBeenCalledTimes(1);
      expect(h.publish).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, ...THINKING_EFFORTS])('preserves supported effort %s', async (effort) => {
    const response = await route.POST(post({
      runtime: 'codex', prompt: 'Inspect the fixture.', cwd: dataDir,
      clientMutationId: 'valid-effort', model: 'gpt-6.1-sol', effort,
    }));
    expect(response.status).toBe(200);
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ effort }), codexIdentity);
  });

  it.each([
    { runtime: 'gemini', model: 'gemini-3-pro-preview', effort: 'high', code: 'effort_unsupported_runtime' },
    { runtime: 'opencode', model: 'opencode/deepseek-v4-flash-free', effort: 'low', code: 'effort_unsupported_runtime' },
    { runtime: 'cursor', model: 'cursor-agent', effort: 'medium', code: 'effort_unsupported_runtime' },
    { runtime: 'codex', model: 'gpt-6-luna', effort: 'ultra', code: 'effort_coerced' },
    { runtime: 'codex', model: 'gpt-5.5', effort: 'max', code: 'effort_coerced' },
    { runtime: 'cloud', model: 'gpt-6-luna', effort: 'ultra', code: 'effort_coerced' },
    { runtime: 'claude-code', model: 'claude-opus-4-7', effort: 'ultra', code: 'effort_coerced' },
  ])('refuses an unpreservable pin before binding: $runtime/$model/$effort', async ({ code, ...selection }) => {
    const body = {
      ...selection, prompt: 'Inspect the fixture.', cwd: dataDir,
      clientMutationId: 'incompatible-effort-correction',
    };
    const response = await route.POST(post(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();

    // A refusal must leave the mutation ID usable, including after reopening
    // the actual receipt database. A valid correction then has normal replay.
    closeDb();
    const corrected = { ...body, runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
    expect((await route.POST(post(corrected))).status).toBe(200);
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    }), codexIdentity);
    closeDb();
    const replay = await route.POST(post(corrected));
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    { runtime: 'gemini', effort: undefined },
    { runtime: 'gemini', effort: 'adaptive' },
    { runtime: 'opencode', effort: 'adaptive' },
    { runtime: 'codex', model: 'gpt-6-luna', effort: 'max' },
    { runtime: 'claude-code', model: 'claude-opus-4-7', effort: 'max' },
    { runtime: 'muse', model: 'muse-wonder', effort: 'high' },
  ])('preserves supported selection $runtime/$effort', async (selection) => {
    const response = await route.POST(post({
      ...selection, prompt: 'Inspect the fixture.', cwd: dataDir,
      clientMutationId: 'supported-runtime-effort',
    }));
    expect(response.status).toBe(200);
    const identity = selection.runtime === 'codex' ? [codexIdentity] : [];
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(selection), ...identity);
  });

  it.each([
    { defaultModel: '', model: undefined, status: 400 },
    { defaultModel: 'gpt-6-luna', model: undefined, status: 400 },
    { defaultModel: 'gpt-6.1-sol', model: undefined, status: 200 },
    { defaultModel: 'gpt-6-luna', model: 'gpt-6.1-sol', status: 200 },
  ])('checks the effective Codex model: default=$defaultModel, explicit=$model', async ({ defaultModel, model, status }) => {
    const original = (await getOperatorDefaults()).values.defaultDispatchModel;
    try {
      await updateOperatorDefaults({ defaultDispatchModel: defaultModel });
      closeDb();
      const response = await route.POST(post({
        runtime: 'codex', model, effort: 'ultra', prompt: 'Inspect the fixture.',
        cwd: dataDir, clientMutationId: 'default-model-effort',
      }));
      expect(response.status).toBe(status);
      if (status === 400) {
        await expect(response.json()).resolves.toMatchObject({ code: 'effort_coerced' });
        expect(h.launch).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
      } else {
        expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ effort: 'ultra', model }), codexIdentity);
      }
    } finally {
      await updateOperatorDefaults({ defaultDispatchModel: original });
    }
  });

  it('retains the single-attempt limit in the real route and its persisted request binding', async () => {
    const body = { runtime: 'codex', prompt: 'Inspect once.', cwd: dataDir,
      model: 'gpt-6.1-sol', effort: 'high', workMode: 'read-only',
      executionPolicy: 'single-attempt', clientMutationId: 'single-attempt-route-proof' };
    expect((await route.POST(post(body))).status).toBe(200);
    expect(h.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ executionPolicy: 'single-attempt' }), codexIdentity);
    closeDb();
    expect((await route.POST(post(body))).headers.get('x-o8-idempotency-replayed')).toBe('1');
    expect((await route.POST(post({ ...body, executionPolicy: undefined }))).status).toBe(409);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown execution limits before the launch boundary', async () => {
    const response = await route.POST(post({ runtime: 'codex', prompt: 'Inspect', cwd: dataDir,
      clientMutationId: 'invalid-execution-policy', executionPolicy: 'retry-until-success' }));
    expect(response.status).toBe(400);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each([{ model: undefined }, { effort: 'adaptive' }, { executionCarrier: 'ori' },
    { model: 'ollama:qwen2.5-coder:32b' }])('rejects widened single-attempt pins before reserving a launch: %j', async (override) => {
    const response = await route.POST(post({ runtime: 'codex', prompt: 'Inspect', cwd: dataDir,
      clientMutationId: 'invalid-single-attempt-pins', executionPolicy: 'single-attempt',
      model: 'gpt-6.1-sol', effort: 'high', workMode: 'read-only', ...override }));
    expect(response.status).toBe(400);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('fails closed when persisted mutation binding throws', async () => {
    const bind = vi.spyOn(idempotency, 'bindIdempotencyClientMutation').mockImplementationOnce(() => {
      throw new Error('runtime launch idempotency write failed');
    });
    try {
      const response = await route.POST(post({
        runtime: 'codex',
        prompt: 'Do not launch without persistence.',
        cwd: dataDir,
        clientMutationId: 'runtime-launch-binding-failure',
      }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: 'runtime launch idempotency write failed' });
      expect(h.launch).not.toHaveBeenCalled();
    } finally {
      bind.mockRestore();
    }
  });

  it('replays an identical completed launch without launching or publishing twice', async () => {
    const body = {
      runtime: 'codex',
      prompt: 'Launch exactly once.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-replay-1',
    };

    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      surfaceId: 'surface-runtime-launch-replay-1',
      clientMutationId: body.clientMutationId,
      replayed: true,
    });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('returns and replays a persisted terminal launch result as a failure', async () => {
    h.launch.mockImplementationOnce(async (request) => ({
      ok: false,
      runtime: request.runtime,
      clientMutationId: request.clientMutationId,
      surfaceId: '',
      note: 'Runtime declined the launch before creating a session.',
      cwd: request.cwd ?? '',
      repoPath: request.repoPath ?? request.cwd ?? '',
      worktree: null,
      laneId: request.existingLaneId ?? null,
    }));
    const body = {
      runtime: 'codex' as const,
      prompt: 'Fail this launch once.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-terminal-failure',
    };

    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(400);
    expect(replay.status).toBe(400);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      note: 'Runtime declined the launch before creating a session.',
      replayed: true,
    });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('persists and replays a same-process post-effect failure without launching twice', async () => {
    h.launch.mockImplementationOnce(async (request) => {
      throw new RuntimeLaunchPostEffectError({
        ok: false,
        runtime: request.runtime,
        clientMutationId: request.clientMutationId,
        surfaceId: 'codex-owned:post-effect-failure',
        note: 'The provider session exists, but governance registration did not settle.',
        cwd: request.cwd ?? '',
        repoPath: request.repoPath ?? request.cwd ?? '',
        worktree: null,
        laneId: null,
      });
    });
    const body = {
      runtime: 'codex' as const,
      prompt: 'Persist this ambiguous result.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-post-effect-failure',
    };

    const first = await route.POST(post(body));
    const replay = await route.POST(post(body));

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      surfaceId: 'codex-owned:post-effect-failure',
      outcomeUnknown: true,
      retryable: false,
      replayed: true,
    });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('returns the launched surface when receipt finalization fails and replays it in-process', async () => {
    const { getSqlite } = await import('@/lib/db');
    const sqlite = getSqlite();
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('UPDATE idempotency_keys SET result_json')) {
        throw new Error('runtime launch finalization failed');
      }
      return originalPrepare(sql);
    }) as typeof sqlite.prepare);
    const body = {
      runtime: 'codex',
      prompt: 'Return the launched surface despite receipt failure.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-finalization-failure',
    };

    try {
      const first = await route.POST(post(body));
      const replay = await route.POST(post(body));

      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        ok: true,
        surfaceId: 'surface-runtime-launch-finalization-failure',
        persistenceDegraded: true,
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        surfaceId: 'surface-runtime-launch-finalization-failure',
        persistenceDegraded: true,
        replayed: true,
      });
      expect(h.launch).toHaveBeenCalledTimes(1);
      expect(h.publish).toHaveBeenCalledTimes(1);
      expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
        mutation: { status: 'queued', surfaceId: 'surface-runtime-launch-finalization-failure' },
      });
    } finally {
      prepare.mockRestore();
    }
  });

  it('returns a safe 202 receipt while the original launch is still running', async () => {
    let complete: ((result: RuntimeLaunchResult) => void) | undefined;
    h.launch.mockImplementationOnce((request) => new Promise((resolve) => {
      complete = resolve;
      expect(request.clientMutationId).toBe('runtime-launch-in-progress-1');
    }));
    const body = {
      runtime: 'codex',
      prompt: 'Hold this launch open.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-in-progress-1',
    };

    const firstPromise = route.POST(post(body));
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));
    const duplicate = await route.POST(post(body));

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      runtime: 'codex',
      clientMutationId: body.clientMutationId,
      surfaceId: '',
      deduped: true,
      replayed: true,
      inProgress: true,
    });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();

    complete?.(successfulResult(body));
    expect((await firstPromise).status).toBe(200);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('reconciles a restart-interrupted owned launch from its durable session marker', async () => {
    const { getSqlite } = await import('@/lib/db');
    const body = {
      runtime: 'codex' as const,
      prompt: 'Recover this owned launch.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-restart-recovery',
    };
    const canonicalBody = JSON.stringify({
      runtime: 'codex',
      prompt: body.prompt,
      clientMutationId: body.clientMutationId,
      cwd: dataDir,
    });
    const key = idempotency.deriveIdempotencyKey({
      verb: 'runtime_launch',
      scopeId: dataDir,
      clientKey: body.clientMutationId,
      body: canonicalBody,
    });
    getSqlite().prepare(`
      INSERT INTO idempotency_keys
        (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
      VALUES (?, 'runtime_launch', ?, NULL, NULL, 'dead-launch-reservation', ?, ?)
    `).run(key, dataDir, Date.now(), Date.now() + 600_000);
    const sessionDir = join(dataDir, 'owned-codex', 'restart-recovery');
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: 'codex-owned:restart-recovery',
      launchMutationId: body.clientMutationId,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'restart recovery',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestPrompt: body.prompt,
      latestSummary: 'running',
      activeRun: { outcome: 'running' },
      recentRuns: [],
    }));
    const { findOwnedLaunchByMutationId, ownedRoots } = await import('@/lib/runtimes/shared/owned-session-index');
    expect(ownedRoots().find((root) => root.marker === 'codex-owned:')?.root).toBe(join(dataDir, 'owned-codex'));
    expect(await findOwnedLaunchByMutationId(body.clientMutationId)).toMatchObject({
      surfaceId: 'codex-owned:restart-recovery',
      outcome: 'running',
    });

    const recovered = await route.POST(post(body));

    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(recovered.json()).resolves.toMatchObject({
      ok: true,
      surfaceId: 'codex-owned:restart-recovery',
      clientMutationId: body.clientMutationId,
      replayed: true,
    });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('holds a recovered isolated provider effect when no governed lane was persisted', async () => {
    const { getSqlite } = await import('@/lib/db');
    const body = {
      runtime: 'codex' as const,
      prompt: 'Do not claim this orphaned isolated launch.',
      cwd: dataDir,
      repoPath: dataDir,
      isolate: true,
      clientMutationId: 'runtime-launch-isolated-orphan',
    };
    const canonicalBody = JSON.stringify({
      runtime: body.runtime,
      prompt: body.prompt,
      clientMutationId: body.clientMutationId,
      cwd: body.cwd,
      repoPath: body.repoPath,
      isolate: true,
    });
    const key = idempotency.deriveIdempotencyKey({
      verb: 'runtime_launch',
      scopeId: dataDir,
      clientKey: body.clientMutationId,
      body: canonicalBody,
    });
    getSqlite().prepare(`
      INSERT INTO idempotency_keys
        (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
      VALUES (?, 'runtime_launch', ?, NULL, NULL, 'dead-isolated-reservation', ?, ?)
    `).run(key, dataDir, Date.now(), Date.now() + 600_000);
    const sessionDir = join(dataDir, 'owned-codex', 'isolated-orphan');
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId: 'codex-owned:isolated-orphan',
      launchMutationId: body.clientMutationId,
      sessionDir,
      cwd: join(dataDir, '.worktrees', 'isolated-orphan'),
      repoPath: join(dataDir, '.worktrees', 'isolated-orphan'),
      title: 'isolated orphan',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestPrompt: body.prompt,
      latestSummary: 'running',
      activeRun: { outcome: 'running' },
      recentRuns: [],
    }));

    const recovered = await route.POST(post(body));

    expect(recovered.status).toBe(409);
    await expect(recovered.json()).resolves.toMatchObject({
      ok: false,
      inProgress: true,
      outcomeUnknown: true,
      surfaceId: '',
    });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('rejects mutation id reuse with a changed canonical launch body', async () => {
    const body = {
      runtime: 'codex',
      prompt: 'First launch body.',
      cwd: dataDir,
      clientMutationId: 'runtime-launch-conflict-1',
    };

    expect((await route.POST(post(body))).status).toBe(200);
    const conflict = await route.POST(post({ ...body, prompt: 'Changed launch body.' }));

    expect(conflict.status).toBe(409);
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('allows deliberate identical launches with distinct mutation ids', async () => {
    const base = { runtime: 'codex', prompt: 'Launch this again.', cwd: dataDir };

    expect((await route.POST(post({ ...base, clientMutationId: 'runtime-launch-repeat-1' }))).status).toBe(200);
    expect((await route.POST(post({ ...base, clientMutationId: 'runtime-launch-repeat-2' }))).status).toBe(200);

    expect(h.launch).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });
});
