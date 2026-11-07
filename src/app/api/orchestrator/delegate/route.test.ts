import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '@/lib/db';

const { launchRuntimeSurface } = vi.hoisted(() => ({
  launchRuntimeSurface: vi.fn(async (input: Record<string, unknown>) => ({
    ok: true,
    surfaceId: `codex-owned:${input.clientMutationId}`,
    note: 'launched',
  })),
}));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ wsPort: 12345 }) }));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'test-token' }));
// The install gate (#3657) reads the host's CLIs; these tests launch through a stub.
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [], 'gpt-5.6-sol': [] } }) }));

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-fast-route-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: repoPath });
  const state = join(root, 'state');
  mkdirSync(join(state, 'chat-history'), { recursive: true });
  writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({
    repoPath,
    messages: [
      { id: 'user-1', role: 'user', content: 'Run these tasks' },
      { id: 'assistant-1', role: 'assistant', content: '', receipt: { pickedMode: 'fast' } },
    ],
  }));
  return { root, repoPath, state };
}

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  launchRuntimeSurface.mockClear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('orchestrator Fast delegation entry', () => {
  it('binds two API launches to one persisted team and their parent chat without worktrees', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const fastCapability = fastDelegationCapability(repoPath, 'thoughts-fast-route');
    const { POST } = await import('./route');
    const dispatch = async (id: string, path: string) => {
      const request = new NextRequest('http://localhost/api/orchestrator/delegate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: `Inspect ${path}`,
          repoPath,
          taskName: path,
          runtime: 'codex',
          checkoutMode: 'shared',
          parentThreadId: 'thoughts-fast-route',
          fastCapability,
          assignedPaths: [path],
          readOnly: true,
          clientMutationId: id,
        }),
      });
      return POST(request);
    };
    const [first, second] = await Promise.all([dispatch('a', 'src/a'), dispatch('b', 'src/b')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).launchContext).toMatchObject({ parentThreadId: 'thoughts-fast-route', checkoutMode: 'shared' });
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(2);
    expect(launchRuntimeSurface.mock.calls.every(([input]) => input.isolate === false && input.skipSetup === true)).toBe(true);
    const teamFiles = (await import('node:fs')).readdirSync(join(state, 'shared-checkout-teams')).filter((file) => file.endsWith('.json'));
    expect(teamFiles).toHaveLength(1);
    const team = JSON.parse(readFileSync(join(state, 'shared-checkout-teams', teamFiles[0]!), 'utf8')) as { members: Array<{ surfaceId: string }> };
    expect(team.members.map((member) => member.surfaceId).sort()).toEqual(['codex-owned:a', 'codex-owned:b']);
    writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({ repoPath, messages: [
      { role: 'user', content: 'Continue in Solo' },
      { role: 'assistant', content: '', receipt: { pickedMode: 'solo' } },
    ] }));
    expect((await dispatch('a', 'src/a')).status).toBe(403);
  });

  it('persists mixed worker choices, preserves adaptive reset, and never duplicates changed replay', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { updateOperatorDefaults, getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ workerRuntimes: ['codex', 'claude-code'], defaultDispatchRuntime: 'codex',
      defaultDispatchModel: 'gpt-5.6-terra', codexWorkerEffort: 'high', subscriptionProfile: 'both' });
    const saved = getOperatorDefaultsSync().values;
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const { POST } = await import('./route');
    const base = { prompt: 'Read the README heading', repoPath, taskName: 'Inspect', checkoutMode: 'shared',
      parentThreadId: 'thoughts-fast-route', fastCapability: fastDelegationCapability(repoPath, 'thoughts-fast-route'), readOnly: true };
    const send = (extra: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/orchestrator/delegate', {
      method: 'POST', body: JSON.stringify({ ...base, ...extra }),
    }));
    const first = { runtime: 'codex', model: 'gpt-5.6-sol', requestedEffort: 'adaptive', clientMutationId: 'pin-a', assignedPaths: ['README.md'] };
    expect((await send(first)).status).toBe(200);
    expect((await send({ runtime: 'claude-code', model: 'claude-sonnet-5', requestedEffort: 'high', clientMutationId: 'pin-b', assignedPaths: ['package.json'] })).status).toBe(200);
    expect(launchRuntimeSurface.mock.calls.map(([input]) => [input.runtime, input.model, input.effort])).toEqual([
      ['codex', 'gpt-5.6-sol', 'adaptive'], ['claude-code', 'claude-sonnet-5', 'high'],
    ]);
    const replay = await send(first);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, workerRouting: { selectedModel: 'gpt-5.6-sol', requestedEffort: 'adaptive' } });
    expect((await send({ ...first, requestedEffort: 'high' })).status).toBe(409);
    expect((await send({ ...first, model: 'missing-model', clientMutationId: 'bad-model' })).status).toBe(400);
    expect((await send({ ...first, runtime: 'gemini', clientMutationId: 'bad-runtime' })).status).toBe(400);
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(2);
    const { readSharedCheckoutTeam } = await import('@/lib/orchestrator/shared-checkout-team');
    const team = readSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-fast-route' });
    expect(team?.members).toHaveLength(2);
    expect(team?.members.map(member => member.workerRouting)).toEqual([
      expect.objectContaining({ selectedRuntime: 'codex', selectedModel: 'gpt-5.6-sol', requestedEffort: 'adaptive', selectedEffort: null }),
      expect.objectContaining({ selectedRuntime: 'claude-code', selectedModel: 'claude-sonnet-5', selectedEffort: 'high' }),
    ]);
    expect(getOperatorDefaultsSync().values).toEqual(saved);
  });

  it('releases a rejected recovered reservation and preserves replay, later work and team completion', async () => {
    const { root, repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    const ownedRoot = join(state, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const { readSharedCheckoutTeam, finishSharedCheckoutTeam } = await import('@/lib/orchestrator/shared-checkout-team');
    const { findOwnedLaunchByMutationId } = await import('@/lib/runtimes/shared/owned-session-index');
    closeDb(); // Reopen the isolated worker database before checking durable replay.
    const { POST } = await import('./route');
    const parentThreadId = 'thoughts-fast-route';
    const teamInput = { repoPath, parentThreadId };
    const fastCapability = fastDelegationCapability(repoPath, parentThreadId);
    const badId = `recovered-mismatch-${basename(root)}`;
    const goodId = `recovered-valid-${basename(root)}`;
    function seed(id: string, directory: string) {
      const sessionDir = join(ownedRoot, id);
      mkdirSync(sessionDir, { recursive: true });
      const record = { surfaceId: `codex-owned:${id}`, launchMutationId: id, sessionDir,
        cwd: directory, repoPath: directory, title: 'Fixture owned worker', createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), latestPrompt: 'Fixture task', latestSummary: 'Finished fixture',
        recentRuns: [{ id: 'fixture-run', mode: 'launch', outcome: 'finished', prompt: 'Fixture task', pid: 0,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stdoutPath: '', stderrPath: '' }] };
      const file = join(sessionDir, 'session.json');
      writeFileSync(file, JSON.stringify(record));
      return { file, bytes: readFileSync(file) };
    }
    const foreign = seed(badId, realpathSync(root));
    seed(goodId, realpathSync(repoPath));
    expect(await findOwnedLaunchByMutationId(badId)).toMatchObject({ cwd: realpathSync(root), outcome: 'finished' });
    const send = (clientMutationId: string) => POST(new NextRequest('http://localhost/api/orchestrator/delegate', {
      method: 'POST', body: JSON.stringify({ prompt: 'Inspect assigned scope', repoPath, taskName: clientMutationId,
        runtime: 'codex', checkoutMode: 'shared', parentThreadId, fastCapability, assignedPaths: ['src/shared'],
        readOnly: true, clientMutationId }),
    }));
    try {
      const rejected = await send(badId);
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ ok: false });
      expect(readSharedCheckoutTeam(teamInput)?.members).toEqual([
        expect.objectContaining({ clientMutationId: badId, state: 'failed', surfaceId: null }),
      ]);
      const afterFailure = readSharedCheckoutTeam(teamInput);
      closeDb(); // Replay must use durable idempotency and membership, not process memory.
      const replay = await send(badId);
      expect(replay.status).toBe(422);
      expect(await replay.json()).toMatchObject({ replayed: true, ok: false });
      expect(readSharedCheckoutTeam(teamInput)).toEqual(afterFailure);
      const valid = await send(goodId);
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ ok: true, surfaceId: `codex-owned:${goodId}` });
      expect(readSharedCheckoutTeam(teamInput)?.members.map(member => member.state)).toEqual(['failed', 'running']);
      await expect(finishSharedCheckoutTeam({ ...teamInput,
        reviewSummary: 'Fixture review: no checkout changes', verification: 'Fixture workers settled' })).resolves.toMatchObject({ committedPaths: [] });
      expect(readSharedCheckoutTeam(teamInput)).toBeNull();
      expect(launchRuntimeSurface).not.toHaveBeenCalled();
      expect(readFileSync(foreign.file)).toEqual(foreign.bytes);
    } finally { closeDb(); }
  });

  it('rejects a bearer caller spoofing the chat, capability, or selected mode', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const { POST } = await import('./route');
    const fastCapability = fastDelegationCapability(repoPath, 'thoughts-fast-route');
    const launch = (parentThreadId: string, capability: string, id: string) => POST(new NextRequest('http://localhost/api/orchestrator/delegate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Inspect', repoPath, checkoutMode: 'shared', parentThreadId,
        fastCapability: capability, clientMutationId: id }),
    }));
    expect((await launch('thoughts-fast-route', '', 'missing-proof')).status).toBe(403);
    expect((await launch('thoughts-spoofed', fastCapability, 'spoof-parent')).status).toBe(404);
    writeFileSync(join(state, 'chat-history', 'thoughts-another-chat.json'), readFileSync(join(state, 'chat-history', 'thoughts-fast-route.json')));
    expect((await launch('thoughts-another-chat', fastCapability, 'other-parent')).status).toBe(403);
    writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({ repoPath, messages: [
      { role: 'user', content: 'Now work solo' },
      { role: 'assistant', content: '', receipt: { pickedMode: 'solo' } },
    ] }));
    expect((await launch('thoughts-fast-route', fastCapability, 'wrong-mode')).status).toBe(403);
    expect(launchRuntimeSurface).not.toHaveBeenCalled();
  });

  it('refuses overlapping Fast worker scopes before launching a second runtime surface', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const { POST } = await import('./route');
    const fastCapability = fastDelegationCapability(repoPath, 'thoughts-fast-route');
    const dispatch = (clientMutationId: string, assignedPaths: string[]) => POST(new NextRequest(
      'http://localhost/api/orchestrator/delegate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Edit assigned files', repoPath, taskName: clientMutationId, runtime: 'codex',
          checkoutMode: 'shared', parentThreadId: 'thoughts-fast-route', fastCapability,
          assignedPaths, clientMutationId,
        }),
      },
    ));
    expect((await dispatch('first', ['src/shared.ts'])).status).toBe(200);
    const overlap = await dispatch('second', ['src/shared.ts']);
    expect(overlap.status).toBe(422);
    expect(await overlap.json()).toEqual({ ok: false,
      error: 'Shared checkout path overlaps worker first; assign separate paths or wait for group review.' });
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
    const teamFiles = (await import('node:fs')).readdirSync(join(state, 'shared-checkout-teams'))
      .filter((file) => file.endsWith('.json'));
    const team = JSON.parse(readFileSync(join(state, 'shared-checkout-teams', teamFiles[0]!), 'utf8')) as {
      members: Array<{ taskName: string; paths: string[]; surfaceId: string }>;
    };
    expect(team.members).toEqual([expect.objectContaining({
      taskName: 'first', paths: ['src/shared.ts'], surfaceId: 'codex-owned:first',
    })]);
  });
});
