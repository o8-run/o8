import { describe, expect, it, vi } from 'vitest';

import { handleClaudeJsonLine, settleOrchestratorTurn } from '@/lib/lane/orchestrator-resident-process';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createToolCallTracker } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorSession } from '@/lib/lane/orchestrator-session';
import type { OrchestratorActiveTurn, WarmState } from '@/lib/lane/orchestrator-session-state';

function residentTurn() {
  const events: OrchestratorEvent[] = [];
  const turn = {
    onEvent: (event: OrchestratorEvent) => events.push(event),
    captureEvent: (event: OrchestratorEvent) => events.push(event),
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => {}, 0),
    abortSignal: null,
    abortListener: null,
    settled: false,
    toolTracker: createToolCallTracker(),
    turnSessionId: 'session-1',
    cost: null,
    lastAssistantText: '',
    sawToolUseAfterText: false,
    launchAgentCallCount: 0,
    crashRecord: null,
    stopCrashTail: null,
    promptFingerprint: null,
  } satisfies OrchestratorActiveTurn;
  const w = { activeTurn: turn, procConfig: null, resumeUnavailable: false } as unknown as WarmState;
  const session = { sessionName: 'test', proc: null, status: 'busy', claudeSessionId: 'session-1' } as unknown as OrchestratorSession;
  const feed = (...lines: unknown[]) => lines.forEach((line) => handleClaudeJsonLine(session, w, JSON.stringify(line)));
  const done = () => events.filter((event) => event.type === 'done');
  return { turn, feed, done, events, session, w };
}

const started = (id: string) => ({ type: 'system', subtype: 'task_started', tool_use_id: id, is_backgrounded: true, task_type: 'local_agent' });
const answered = (id: string) => ({ type: 'system', subtype: 'task_notification', tool_use_id: id, status: 'completed', summary: `${id} answer` });
const requesting = { type: 'system', subtype: 'status', status: 'requesting' };
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, session_id: 'session-1' });

describe('a resident Claude turn with background agents', () => {
  it('stays open through each agent, as in a captured two-agent turn', () => {
    const { turn, feed, done } = residentTurn();
    feed(started('a1'), started('a2'), requesting, result('Both are running.'));
    expect(done()).toEqual([]);
    feed(answered('a1'), requesting, result('One is done.'));
    expect(done()).toEqual([]);
    feed(answered('a2'), requesting);
    expect(done()).toEqual([]);
    feed(result('Both finished.'));
    expect(done()).toMatchObject([{ terminalOutcome: 'completed' }]);
    expect(turn.resolve).toHaveBeenCalledOnce();
  });

  it('completes a held turn when its log ends', () => {
    const { feed, done, session, w } = residentTurn();
    feed(started('a1'), result('Started.'));
    settleOrchestratorTurn(session, w, null);
    expect(done()).toMatchObject([{ terminalOutcome: 'completed' }]);
  });

  it('ends at the first result when only a background shell runs', () => {
    const { feed, done } = residentTurn();
    feed({ ...started('s1'), task_type: 'local_bash' }, result('The server is up.'));
    expect(done()).toHaveLength(1);
  });

  it('does not hold a failed result', () => {
    const { feed, done } = residentTurn();
    feed(started('a1'), { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
    expect(done()).toHaveLength(1);
  });
});
