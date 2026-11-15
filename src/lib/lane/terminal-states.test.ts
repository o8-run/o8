import { getSqlite } from '@/lib/db';
import { projectMergeModeKey } from './project-merge-mode-migration';
import { describe, expect, it } from 'vitest';

import { createLane, getLane, getLaneEvents, setLaneStatus } from './registry';
import {
  LANE_TERMINAL_STATUSES,
  TERMINAL_LANE_STATUSES,
  WORKER_TERMINAL_STATUSES,
  isLaneTerminal,
  isRefusedTerminalTransition,
  isWorkerTerminal,
} from './terminal-states';
import { isTerminalLaneStatus } from './types';
import { dispatch } from './commands';

function laneFixture(branch: string) {
  return createLane({
    repoPath: '/tmp/o8-terminal-state-test-repo',
    branch,
    baseBranch: 'main',
    runtime: 'codex',
  });
}

describe('isRefusedTerminalTransition', () => {
  it('refuses re-opening a terminal lane (the #531 supervisor race)', () => {
    expect(isRefusedTerminalTransition('completed', 'awaiting_input')).toBe(true);
    expect(isRefusedTerminalTransition('completed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('failed', 'running')).toBe(true);
    expect(isRefusedTerminalTransition('archived', 'running')).toBe(true);
  });

  it('allows archiving from any terminal state', () => {
    expect(isRefusedTerminalTransition('completed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'archived')).toBe(false);
    expect(isRefusedTerminalTransition('archived', 'archived')).toBe(false);
  });

  it('allows idempotent same-status writes', () => {
    expect(isRefusedTerminalTransition('completed', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('failed', 'failed')).toBe(false);
  });

  it('never refuses transitions from non-terminal states', () => {
    expect(isRefusedTerminalTransition('running', 'completed')).toBe(false);
    expect(isRefusedTerminalTransition('awaiting_input', 'failed')).toBe(false);
    expect(isRefusedTerminalTransition('merging', 'running')).toBe(false);
  });

  it('terminal set stays exactly failed/completed/archived', () => {
    expect([...TERMINAL_LANE_STATUSES].sort()).toEqual(['archived', 'completed', 'failed']);
  });
});

describe('unified terminal-state truth (lane vs worker)', () => {
  it('LANE_TERMINAL excludes reviewing; WORKER_TERMINAL includes it', () => {
    expect([...LANE_TERMINAL_STATUSES].sort()).toEqual(['archived', 'completed', 'failed']);
    expect([...WORKER_TERMINAL_STATUSES].sort()).toEqual([
      'archived',
      'completed',
      'failed',
      'reviewing',
    ]);
    // The alias must point at the lane-terminal set, not the worker set.
    expect(TERMINAL_LANE_STATUSES).toBe(LANE_TERMINAL_STATUSES);
  });

  it('isLaneTerminal treats reviewing as NOT terminal (merge still ahead)', () => {
    expect(isLaneTerminal('reviewing')).toBe(false);
    expect(isLaneTerminal('completed')).toBe(true);
    expect(isLaneTerminal('failed')).toBe(true);
    expect(isLaneTerminal('archived')).toBe(true);
    expect(isLaneTerminal('running')).toBe(false);
    expect(isLaneTerminal('awaiting_orchestrator')).toBe(false);
    expect(isLaneTerminal(null)).toBe(false);
    expect(isLaneTerminal(undefined)).toBe(false);
  });

  it('isWorkerTerminal treats reviewing as terminal (worker done, awaiting merge)', () => {
    expect(isWorkerTerminal('reviewing')).toBe(true);
    expect(isWorkerTerminal('completed')).toBe(true);
    expect(isWorkerTerminal('failed')).toBe(true);
    expect(isWorkerTerminal('archived')).toBe(true);
    expect(isWorkerTerminal('running')).toBe(false);
    expect(isWorkerTerminal('merging')).toBe(false);
    expect(isWorkerTerminal('recovering')).toBe(false);
    expect(isWorkerTerminal(null)).toBe(false);
    expect(isWorkerTerminal(undefined)).toBe(false);
  });

  it('the types.ts delegate is exactly the worker-terminal notion', () => {
    for (const status of ['reviewing', 'failed', 'completed', 'archived', 'running', 'merging', 'awaiting_orchestrator'] as const) {
      expect(isTerminalLaneStatus(status)).toBe(isWorkerTerminal(status));
    }
  });
});

describe('terminal lane status guard - real callers', () => {
  it('persists the semantic status label in the append-only event payload', () => {
    const lane = laneFixture('inline/status-event-label');
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    expect(getLaneEvents(lane.id).findLast((event) => event.verb === 'status_change')?.payload)
      .toMatchObject({ status: 'running', eventLabel: 'session_launched' });
  });

  it('refuses direct registry re-open writes after completion', () => {
    const lane = laneFixture('inline/terminal-registry');
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const attempted = setLaneStatus(lane.id, 'reviewing', 'system', 'merge_error');

    expect(attempted?.status).toBe('completed');
    expect(attempted?.lastEventLabel).toBe('merged');
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it.each(['pr_only', 'direct'])('refuses merge command fallback paths that try to re-open a completed lane (%s)', async (mode) => {
    const lane = laneFixture(`inline/terminal-merge-command-${mode}`);
    getSqlite().prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(projectMergeModeKey(lane.projectId ?? 'default'), mode, Date.now());
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const result = await dispatch({
      verb: 'merge',
      laneId: lane.id,
      actor: 'user',
    });

    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/No worktree to merge/);
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(getLane(lane.id)?.lastEventLabel).toBe('merged');
  }, 20_000);

  it('allows archive as the only terminal successor through the command bus', async () => {
    const lane = laneFixture('inline/terminal-archive-command');
    setLaneStatus(lane.id, 'completed', 'system', 'merged');

    const result = await dispatch({
      verb: 'archive',
      laneId: lane.id,
      outcome: 'merged',
      outcomeNote: 'Recorded before archival.',
      actor: 'user',
    });

    expect(result.ok).toBe(true);
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'merged',
      outcomeNote: 'Recorded before archival.',
    });
  }, 20_000);
});
