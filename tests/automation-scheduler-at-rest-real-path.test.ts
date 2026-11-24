import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-automation-rest-data-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-automation-rest-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
delete process.env.O8_DISABLE_AUTOMATIONS;

vi.mock('@/lib/automations/runner', () => ({ runAutomation: vi.fn(async () => ({ ok: true, laneId: null, note: 'fixture' })) }));

const automationsRoute = await import('@/app/api/automations/route');
const automationRoute = await import('@/app/api/automations/[id]/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const {
  automationSchedulerTimerDueAt,
  bootAutomationsScheduler,
  NEXT_DUE_PATH,
  resetAutomationsSchedulerForTests,
} = await import('@/lib/automations/scheduler');
const {
  ingestLaneAutomationSourceEvents,
  pruneAutomationSourceEvents,
  recordAutomationSourceEvent,
} = await import('@/lib/automations/source-events');

const heartbeat = join(dataDir, 'automations-scheduler.heartbeat');
const nextDue = () => JSON.parse(readFileSync(NEXT_DUE_PATH, 'utf8')) as { nextDueAt: number | null; stayAwake: boolean };
const sourceEventCount = () => (getSqlite().prepare('SELECT count(*) AS n FROM automation_source_events').get() as { n: number }).n;

async function createAutomation(body: Record<string, unknown>) {
  const response = await automationsRoute.POST(new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'fixture', owner: 'rest-owner', repoPath, branch: 'main', runtime: 'codex',
      prompt: 'Fixture automation.', ...body,
    }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { automation: { id: string } }).automation;
}

afterEach(() => resetAutomationsSchedulerForTests());
afterAll(() => {
  closeDb();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('automation scheduler at rest', () => {
  it('does nothing with no automation: no timer, no heartbeat, no source event intake', async () => {
    bootAutomationsScheduler();
    expect(automationSchedulerTimerDueAt()).toBeNull();
    expect(nextDue()).toMatchObject({ nextDueAt: null, stayAwake: false });

    expect(recordAutomationSourceEvent({
      sourceKind: 'managed_run', sourceId: 'run-1', repoPath, eventType: 'output', payload: { chunk: 'x' },
    })).toBeNull();
    const lane = createLane({ repoPath, branch: 'b', baseBranch: 'main', runtime: 'codex', packetId: 'pkt-rest' });
    recordLaneEvent(lane.id, 'update', 'system', { code: 'fixture' });
    expect(ingestLaneAutomationSourceEvents()).toBe(0);
    expect(sourceEventCount()).toBe(0);

    // Nothing became due, so no tick ran and nothing was written.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(existsSync(heartbeat)).toBe(false);
  });

  it('sleeps until the next scheduled run, publishes it, and stops when the automation goes', async () => {
    bootAutomationsScheduler();
    const automation = await createAutomation({ triggerKind: 'cron', cronExpr: '0 3 * * *' });
    const scheduled = getSqlite().prepare('SELECT next_run_at FROM automations WHERE id = ?').get(automation.id) as { next_run_at: number };
    expect(scheduled.next_run_at).toBeGreaterThan(Date.now());
    expect(automationSchedulerTimerDueAt()).toBe(scheduled.next_run_at);
    expect(nextDue()).toMatchObject({ nextDueAt: scheduled.next_run_at, stayAwake: false });
    expect(existsSync(heartbeat)).toBe(false);

    const deleted = await automationRoute.DELETE(new Request('http://localhost/api/automations/x', { method: 'DELETE' }),
      { params: Promise.resolve({ id: automation.id }) });
    expect(deleted.status).toBe(200);
    expect(automationSchedulerTimerDueAt()).toBeNull();
    expect(nextDue()).toMatchObject({ nextDueAt: null });
  });

  it('keeps events only for watched sources, and drops read ones past a week', async () => {
    bootAutomationsScheduler();
    const watch = await createAutomation({
      triggerKind: 'watch', watchSourceKind: 'repository', watchEventTypes: [], watchActionKind: 'dispatch',
    });
    expect(recordAutomationSourceEvent({
      sourceKind: 'managed_run', sourceId: 'run-2', repoPath, eventType: 'output',
    })).toBeNull();
    const now = Date.now();
    const old = recordAutomationSourceEvent({
      sourceKind: 'repository', sourceId: 'owner/repo', repoPath, eventType: 'check_completed',
      fingerprint: 'old', occurredAt: now - 8 * 86_400_000, persistedAt: now - 8 * 86_400_000,
    });
    const fresh = recordAutomationSourceEvent({
      sourceKind: 'repository', sourceId: 'owner/repo', repoPath, eventType: 'check_completed', fingerprint: 'fresh',
    });
    expect(old && fresh).toBeTruthy();
    // An unread old event is kept until the watch reads past it.
    expect(pruneAutomationSourceEvents(now)).toBe(0);
    getSqlite().prepare('UPDATE automations SET watch_checkpoint = ? WHERE id = ?').run(old!.sequence, watch.id);
    expect(pruneAutomationSourceEvents(now)).toBe(1);
    expect(sourceEventCount()).toBe(1);
  });
});
