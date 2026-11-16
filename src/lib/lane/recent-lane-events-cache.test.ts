import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

process.env.O8_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-recent-lane-events-'));
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;

vi.mock('server-only', () => ({}));

const { getSqlite } = await import('@/lib/db');
const { appendEvent, createLane } = await import('./registry');
const { buildDomainLaneSummaries } = await import('@/lib/orchestrator/control-plane');

function exitedLane(packetId: string) {
  const lane = createLane({ repoPath: '/repo', projectId: 'p', branch: `b-${packetId}`, runtime: 'codex', packetId, sessionKey: `s-${packetId}` });
  appendEvent(lane.id, 'runtime_process_exit', 'system', { runtime: 'codex', surfaceId: `s-${packetId}`, runtimeOutcome: 'failed', stderr: 'error: refresh_token_reused' });
  return lane;
}

const exitEvent = (laneId: string) => getSqlite()
  .prepare("SELECT rowid AS id FROM lane_events WHERE lane_id = ? AND verb = 'runtime_process_exit'")
  .get(laneId) as { id: number };

describe('lane summaries across headless ticks', () => {
  it('does not re-read a lane whose events have not changed', () => {
    const lane = exitedLane('silent');
    const first = buildDomainLaneSummaries(new Set(['silent']));
    expect(first[0]?.failureMessage).toBeTruthy();
    // No o8 writer edits an event in place. Doing it here shows whether the
    // second build re-read the rows: a cached build still sees the first value.
    getSqlite().prepare("UPDATE lane_events SET verb = 'note' WHERE rowid = ?").run(exitEvent(lane.id).id);
    const second = buildDomainLaneSummaries(new Set(['silent']));
    expect(second[0]?.failureMessage).toBe(first[0]?.failureMessage);
  });

  it('sees an event appended by any writer and an event deleted', () => {
    const lane = exitedLane('busy');
    expect(buildDomainLaneSummaries(new Set(['busy']))[0]?.failureMessage).toBeTruthy();
    // A raw insert, as the heal bot and storage migration write events. An
    // attach after the exit clears the failure.
    getSqlite().prepare(`
      INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp)
      VALUES ('raw-attach', ?, 'attach_session', 'system', '{}', ?)
    `).run(lane.id, new Date(Date.now() + 1_000).toISOString());
    expect(buildDomainLaneSummaries(new Set(['busy']))[0]?.failureMessage).toBeNull();

    getSqlite().prepare("DELETE FROM lane_events WHERE id = 'raw-attach'").run();
    expect(buildDomainLaneSummaries(new Set(['busy']))[0]?.failureMessage).toBeTruthy();
  });
});
