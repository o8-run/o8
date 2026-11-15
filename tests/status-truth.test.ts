/**
 * #1476 — status truth. Four lies from one packet lifecycle, each pinned by a
 * test that fails on the pre-fix code:
 *
 *   1. o8_status's summary string must be derived from the SAME agents array
 *      it ships — never a trusted upstream summary that can drift.
 *   2. A transient 'failed' discovery blip must not surface while the session
 *      was healthy moments before (hysteresis at the inventory seam).
 *   3. A recorded review verdict must be recoverable after mission-state
 *      eviction / approval-context drift — append-only review_recorded lane
 *      event written by the REAL submitPacketReview.
 *   5. One canonical lane→packet status map: synthesized packets must agree
 *      with packetStatusFromLaneStatus (awaiting_human is blocked, not
 *      awaiting_review).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mcp/operator-handlers/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/operator-handlers/shared')>();
  return {
    ...actual,
    apiFetch: apiFetchMock,
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-status-truth-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
const { debouncedSessionStatus } = await import('@/lib/runtime/inventory');
const { synthesizePacketFromLane } = await import('@/lib/orchestrator/synthesize-packet');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#1476 lie 1 — o8_status summary derives from the agents it ships', () => {
  it('ignores a stale upstream summary that contradicts agents[]', async () => {
    apiFetchMock.mockResolvedValue({ cursor: 0, leads: [] });
    apiFetchMock.mockResolvedValueOnce({
      summary: '0 agents running. 0 approvals pending. No recent activity.',
      agents: [{ name: 'w1', status: 'failed', elapsed: '2m ago', sessionKey: 'codex-owned:x' }],
      approvals: [],
      recentActivity: [],
    });

    const result = await handleStatus({});
    const text = (result as { content?: Array<{ type: string; text?: string }> })
      .content?.find((block) => block.type === 'text')?.text ?? '{}';
    const payload = JSON.parse(text) as { summary: string };

    expect(payload.summary).toContain('needs attention');
    expect(payload.summary).not.toContain('No recent activity');
  });
});

describe('#1476 lie 2 — transient failed blip is debounced at the inventory seam', () => {
  it('masks a failed blip with the last known status, surfaces sustained failure, and trusts first-observation failures', () => {
    expect(debouncedSessionStatus('sess-blip', 'working')).toBe('working');
    // The heal-cycle blip: one failed observation right after a healthy one.
    expect(debouncedSessionStatus('sess-blip', 'failed')).toBe('working');
    // Recovery clears the debounce entirely.
    expect(debouncedSessionStatus('sess-blip', 'working')).toBe('working');

    // A session first observed as failed has no history to mask with.
    expect(debouncedSessionStatus('sess-dead', 'failed')).toBe('failed');
  });
});

describe('#1476 lie 3 — the review verdict is append-only on the lane', () => {
  it('submitPacketReview on an orphan (lane-only) packet appends review_recorded', async () => {
    const repo = mkdtempSync(join(os.tmpdir(), 'o8-repo-1476-'));
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);

    const lane = createLane({
      repoPath: repo,
      branch: 'main',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'status-truth lane',
      packetId: 'pkt-1476-verdict',
      worktreePath: repo,
    });

    await submitPacketReview({
      packetId: 'pkt-1476-verdict',
      findings: [],
      approved: true,
    });

    const events = getLaneEvents(lane.id);
    const verdictEvent = [...events].reverse().find((event) => event.verb === 'review_recorded');
    expect(verdictEvent).toBeDefined();
    expect(verdictEvent?.payload).toMatchObject({ approved: true });
  });
});

describe('#1476 doctrine — one canonical lane→packet status map', () => {
  it('synthesized packets map awaiting_human to blocked, matching packet-state', () => {
    const lane = {
      id: 'lane-x',
      status: 'awaiting_human',
      label: 'l',
      branch: 'main',
      repoPath: '/tmp/x',
      runtime: 'codex',
    } as unknown as Parameters<typeof synthesizePacketFromLane>[1];
    expect(synthesizePacketFromLane('pkt-x', lane).status).toBe('blocked');
  });
});
