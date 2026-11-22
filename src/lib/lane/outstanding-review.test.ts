import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-outstanding-review-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

vi.mock('server-only', () => ({}));

import { createLane, setLaneStatus } from './registry';
import { hasLaneBlockingIdle, hasOutstandingReview } from './outstanding-review';

it('reports an outstanding review only while a lane is in review', () => {
  expect(hasOutstandingReview()).toBe(false);
  const lane = createLane({ repoPath: '/repo', branch: 'fix/review', runtime: 'codex', packetId: 'pkt-review' });
  setLaneStatus(lane.id, 'running', 'system', 'test');
  expect(hasOutstandingReview()).toBe(false);
  setLaneStatus(lane.id, 'reviewing', 'system', 'test');
  expect(hasOutstandingReview()).toBe(true);
  setLaneStatus(lane.id, 'archived', 'system', 'test');
  expect(hasOutstandingReview()).toBe(false);
});

it('blocks the idle gate only for launching, running and merging lanes', () => {
  expect(hasLaneBlockingIdle()).toBe(false);
  const lane = createLane({ repoPath: '/repo', branch: 'fix/activity', runtime: 'cloud' });
  expect(hasLaneBlockingIdle()).toBe(false);
  for (const status of ['launching', 'running', 'merging'] as const) {
    setLaneStatus(lane.id, status, 'system', 'test');
    expect(hasLaneBlockingIdle()).toBe(true);
  }
  setLaneStatus(lane.id, 'reviewing', 'system', 'test');
  expect(hasLaneBlockingIdle()).toBe(false);
});
