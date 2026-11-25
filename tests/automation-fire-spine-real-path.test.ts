import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  laneSequence: 0,
  launches: 0,
  active: 0,
  maxActive: 0,
  runnerLoads: 0,
  watchActionLoads: 0,
  activeByRepo: new Map<string, number>(),
  maxByRepo: new Map<string, number>(),
  laneRepos: new Map<string, string>(),
}));

vi.mock('@/lib/automations/runner', async original => {
  state.runnerLoads++;
  return original();
});

vi.mock('@/lib/automations/watch-actions', async original => {
  state.watchActionLoads++;
  return original();
});

vi.mock('@/lib/repos/registry', () => ({
  findRepoByLocalPath: vi.fn(async (repoPath: string) => ({
    id: `repo:${repoPath}`,
    localPath: repoPath,
    setup: {
      envMode: 'none',
      envFiles: [],
      workspaceIsolationPreference: 'main',
      installOnCreateWorkspace: false,
    },
  })),
}));

vi.mock('@/lib/worktree/launch', () => ({
  prepareLaunchWorktree: vi.fn(async () => null),
}));

vi.mock('@/lib/lane/commands', () => ({
  dispatch: vi.fn(async (command: Record<string, unknown>) => {
    if (command.verb === 'open_lane') {
      const laneId = `lane-automation-fire-${++state.laneSequence}`;
      state.laneRepos.set(laneId, String(command.repoPath));
      return { ok: true, laneId };
    }
    if (command.verb !== 'launch_session') return { ok: true };
    const laneId = String(command.laneId);
    const repoPath = state.laneRepos.get(laneId) ?? 'unknown';
    state.launches += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const repoActive = (state.activeByRepo.get(repoPath) ?? 0) + 1;
    state.activeByRepo.set(repoPath, repoActive);
    state.maxByRepo.set(repoPath, Math.max(state.maxByRepo.get(repoPath) ?? 0, repoActive));
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.active -= 1;
    state.activeByRepo.set(repoPath, repoActive - 1);
    if (String(command.prompt).includes('[fail]')) return { ok: false, note: 'planted dispatch failure' };
    return { ok: true, note: 'automation launched' };
  }),
}));


const dataDir = mkdtempSync(join(tmpdir(), 'o8-automation-fire-spine-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const createRoute = await import('@/app/api/automations/route');
const runRoute = await import('@/app/api/automations/[id]/run/route');
const automationRoute = await import('@/app/api/automations/[id]/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const {
  getAutomationFire,
  getAutomationFireMetrics,
  claimNextAutomationFire,
  listAutomationFires,
  materializeDueAutomationFires,
  persistManualAutomationFire,
  recoverExpiredAutomationFires,
} = await import('@/lib/automations/fire-store');
const { runAutomationSchedulerTick } = await import('@/lib/automations/scheduler');

async function createAutomation(input: {
  name: string;
  repoPath: string;
  triggerKind?: 'manual' | 'cron';
  catchUpPolicy?: 'latest' | 'all' | 'skip';
  prompt?: string;
}) {
  const response = await createRoute.POST(new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      owner: 'operator@example.test',
      repoPath: input.repoPath,
      branch: 'main',
      runtime: 'codex',
      prompt: input.prompt ?? `run ${input.name}`,
      triggerKind: input.triggerKind ?? 'manual',
      cronExpr: input.triggerKind === 'cron' ? '* * * * *' : null,
      catchUpPolicy: input.catchUpPolicy ?? 'latest',
      repoConcurrencyLimit: 1,
    }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { automation: { id: string } }).automation;
}

async function manualRun(automationId: string, clientMutationId: string) {
  return runRoute.POST(new Request('http://localhost/api/automations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId }),
  }), { params: Promise.resolve({ id: automationId }) });
}

beforeEach(() => {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM automation_fires').run();
  sqlite.prepare('DELETE FROM automations').run();
  state.laneSequence = 0;
  state.launches = 0;
  state.active = 0;
  state.maxActive = 0;
  state.activeByRepo.clear();
  state.maxByRepo.clear();
  state.laneRepos.clear();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable automation fire spine', () => {
  it('loads the launch executor only when the actual scheduler claims due work', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z').getTime();
    expect(await runAutomationSchedulerTick({ nowMs: now })).toEqual({ materialized: [], completed: [] });
    expect(state.runnerLoads).toBe(0);
    expect(state.watchActionLoads).toBe(0);

    const automation = await createAutomation({
      name: 'Due fixture',
      repoPath: '/tmp/automation-lazy-executor',
      triggerKind: 'cron',
    });
    getSqlite().prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now, automation.id);

    const result = await runAutomationSchedulerTick({ nowMs: now });
    expect(result.completed).toMatchObject([{ automationId: automation.id, status: 'succeeded', claimCount: 1 }]);
    expect(state.launches).toBe(1);
    expect(state.runnerLoads).toBe(1);
    expect(state.watchActionLoads).toBe(0);
  });

  it('dedupes two schedulers while running independent repos concurrently and serializing each repo', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z').getTime();
    const definitions = [
      ['repo-a-1', '/tmp/automation-repo-a'],
      ['repo-a-2', '/tmp/automation-repo-a'],
      ['repo-b-1', '/tmp/automation-repo-b'],
      ['repo-b-2', '/tmp/automation-repo-b'],
    ] as const;
    const automations = await Promise.all(definitions.map(([name, repoPath]) => createAutomation({
      name,
      repoPath,
      triggerKind: 'cron',
      catchUpPolicy: 'latest',
    })));
    const sqlite = getSqlite();
    for (const automation of automations) {
      sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now - 60_000, automation.id);
    }

    await Promise.all([
      runAutomationSchedulerTick({ nowMs: now, workerId: 'scheduler-a', concurrencyCap: 2, maxClaims: 8 }),
      runAutomationSchedulerTick({ nowMs: now, workerId: 'scheduler-b', concurrencyCap: 2, maxClaims: 8 }),
    ]);

    expect(state.launches).toBe(4);
    expect(state.maxActive).toBe(2);
    expect(state.maxByRepo.get('/tmp/automation-repo-a')).toBe(1);
    expect(state.maxByRepo.get('/tmp/automation-repo-b')).toBe(1);
    const fireColumns = getSqlite().prepare('PRAGMA table_info(automation_fires)')
      .all() as Array<{ name: string }>;
    expect(fireColumns.map((column) => column.name)).not.toContain('lease_token');
    for (const automation of automations) {
      const fires = listAutomationFires(automation.id);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ status: 'succeeded', claimCount: 1, attemptCount: 1 });
      expect(getSqlite().prepare(`
        SELECT team_id, concurrency_key, concurrency_limit, status
        FROM cloud_jobs WHERE id = ?
      `).get(fires[0].executionJobId)).toMatchObject({
        team_id: 'automation',
        concurrency_key: fires[0].repoPath,
        concurrency_limit: 1,
        status: 'completed',
      });
    }
  });

  it('keeps manual retries idempotent and preserves a recovered fire across database restart', async () => {
    const automation = await createAutomation({ name: 'manual durable', repoPath: '/tmp/manual-durable' });
    const first = await manualRun(automation.id, 'manual-request-1');
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { fire: { id: string } };
    const replay = await manualRun(automation.id, 'manual-request-1');
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true, fire: { id: firstBody.fire.id } });
    expect(state.launches).toBe(1);
    expect(getAutomationFireMetrics(automation.id).duplicateFireCount).toBe(1);

    const persisted = persistManualAutomationFire(automation.id, 'restart-gap-1');
    expect(persisted).toMatchObject({ status: 'pending' });
    closeDb();
    await runAutomationSchedulerTick({ workerId: 'scheduler-after-restart', concurrencyCap: 2, maxClaims: 2 });
    expect(getAutomationFire(persisted!.id)).toMatchObject({ status: 'succeeded', claimCount: 1 });
    expect(state.launches).toBe(2);

    const abandoned = persistManualAutomationFire(automation.id, 'abandoned-lease-1');
    const leaseStartedAt = Date.now();
    const claimed = claimNextAutomationFire({
      workerId: 'lost-scheduler',
      leaseMs: 5,
      concurrencyCap: 2,
      fireId: abandoned?.id,
      nowMs: leaseStartedAt,
    });
    expect(claimed).toMatchObject({ status: 'leased', attemptCount: 0 });
    closeDb();
    expect(recoverExpiredAutomationFires(leaseStartedAt + 10)).toBe(1);
    expect(getAutomationFire(abandoned!.id)).toMatchObject({
      status: 'recovered',
      recoveryCount: 1,
      attemptCount: 0,
    });
    await runAutomationSchedulerTick({
      nowMs: leaseStartedAt + 10,
      workerId: 'recovery-scheduler',
      concurrencyCap: 2,
      maxClaims: 2,
    });
    expect(getAutomationFire(abandoned!.id)).toMatchObject({ status: 'succeeded', recoveryCount: 1 });
    expect(state.launches).toBe(3);
  });

  it('materializes zero, one, latest, all, and skipped downtime slots without overwriting failures', async () => {
    const now = new Date('2026-08-26T13:00:00.000Z').getTime();
    const zero = await createAutomation({ name: 'zero slots', repoPath: '/tmp/catch-zero', triggerKind: 'cron', catchUpPolicy: 'all' });
    const one = await createAutomation({ name: 'one slot', repoPath: '/tmp/catch-one', triggerKind: 'cron', catchUpPolicy: 'all' });
    const latest = await createAutomation({ name: 'latest slots', repoPath: '/tmp/catch-latest', triggerKind: 'cron', catchUpPolicy: 'latest' });
    const all = await createAutomation({ name: 'all slots', repoPath: '/tmp/catch-all', triggerKind: 'cron', catchUpPolicy: 'all' });
    const skip = await createAutomation({ name: 'skip slots', repoPath: '/tmp/catch-skip', triggerKind: 'cron', catchUpPolicy: 'skip' });
    const hourlyLatest = await createAutomation({
      name: 'hourly latest',
      repoPath: '/tmp/catch-hourly-latest',
      triggerKind: 'cron',
      catchUpPolicy: 'latest',
    });
    const sqlite = getSqlite();
    sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now + 60_000, zero.id);
    sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now, one.id);
    sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now - 180_000, latest.id);
    sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now - 120_000, all.id);
    sqlite.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(now - 180_000, skip.id);
    sqlite.prepare("UPDATE automations SET cron_expr = '0 * * * *', next_run_at = ? WHERE id = ?")
      .run(new Date('2026-08-26T10:00:00.000Z').getTime(), hourlyLatest.id);
    materializeDueAutomationFires(now);

    expect(listAutomationFires(zero.id)).toHaveLength(0);
    expect(listAutomationFires(one.id)).toHaveLength(1);
    expect(listAutomationFires(latest.id)).toHaveLength(1);
    expect(listAutomationFires(all.id)).toHaveLength(3);
    expect(listAutomationFires(skip.id)).toHaveLength(0);
    expect(listAutomationFires(hourlyLatest.id)).toEqual([
      expect.objectContaining({ slotMs: new Date('2026-08-26T13:00:00.000Z').getTime() }),
    ]);

    const cancellable = persistManualAutomationFire(one.id, 'cancel-on-disable');
    const disabled = await automationRoute.PATCH(new Request('http://localhost/api/automations/one', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }), { params: Promise.resolve({ id: one.id }) });
    expect(disabled.status).toBe(200);
    expect(getAutomationFire(cancellable!.id)).toMatchObject({
      status: 'cancelled',
      resultNote: 'Automation disabled by the operator.',
    });

    const failed = await createAutomation({
      name: 'history survives',
      repoPath: '/tmp/history-survives',
      prompt: '[fail] preserve this result',
    });
    const failedResponse = await manualRun(failed.id, 'failed-run-1');
    expect(failedResponse.status).toBe(502);
    sqlite.prepare("UPDATE automations SET prompt = 'succeed now' WHERE id = ?").run(failed.id);
    const successResponse = await manualRun(failed.id, 'successful-run-2');
    expect(successResponse.status).toBe(200);
    expect(listAutomationFires(failed.id)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'parked', resultNote: 'planted dispatch failure' }),
    ]);
    const metrics = getAutomationFireMetrics(failed.id);
    expect(metrics).toMatchObject({
      count: 2,
      queueDelayMs: { p50: expect.any(Number), p95: expect.any(Number) },
      executionMs: { p50: expect.any(Number), p95: expect.any(Number) },
    });
  });
});
