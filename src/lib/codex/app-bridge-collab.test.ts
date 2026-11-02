import { describe, expect, it } from 'vitest';

import { createCollabTracker } from '@/lib/codex/app-bridge-collab';

const spawn = { id: 'c1', tool: 'spawnAgent', prompt: 'Sort the fruit\nthen stop', model: 'gpt-6.1-sol' };
const outputs = (lines: Record<string, unknown>[]) => lines.flatMap((line) => (line.type === 'response_item' ? [line.payload] : []));

describe('codex collab items', () => {
  it('reports a spawn as one Agent call that finishes with the agent answer', () => {
    const tracker = createCollabTracker();
    expect(tracker.lines('started', spawn)).toMatchObject([
      { item: { type: 'tool_use', id: 'c1', name: 'Agent', arguments: { description: 'Sort the fruit' } } },
    ]);
    const launched = tracker.lines('completed', {
      ...spawn, status: 'completed', receiverThreadIds: ['t1'], agentsStates: { t1: { status: 'running', message: null } },
    });
    expect(launched).toEqual([]);
    const waited = tracker.lines('completed', {
      id: 'w1', tool: 'wait', status: 'completed', agentsStates: { t1: { status: 'completed', message: 'apple, banana' } },
    });
    expect(outputs(waited)).toEqual([{ type: 'function_call_output', call_id: 'c1', name: 'Agent', output: 'apple, banana' }]);
    expect(tracker.lines('completed', { id: 'w2', tool: 'wait', agentsStates: { t1: { status: 'completed', message: 'again' } } })).toEqual([]);
  });

  it('ends a spawn that failed to start', () => {
    const tracker = createCollabTracker();
    const lines = tracker.lines('completed', { ...spawn, status: 'failed', receiverThreadIds: [] });
    expect(outputs(lines)).toMatchObject([{ call_id: 'c1', output: 'The subagent did not start.' }]);
  });

  it('ignores the other collab tools', () => {
    const tracker = createCollabTracker();
    expect(tracker.lines('started', { id: 's', tool: 'sendInput', prompt: 'go' })).toEqual([]);
  });
});
