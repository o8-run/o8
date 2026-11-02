import { describe, expect, it } from 'vitest';

import { createSubagentTracker } from '@/lib/codex/app-bridge-subagents';

const started = { type: 'subAgentActivity', id: 'call_1', kind: 'started', agentThreadId: 't1', agentPath: '/root/number_reply', model: 'gpt-6-luna' };
const completed = { type: 'subAgentActivity', id: 'subagent-completed-1', kind: 'completed', agentThreadId: 't1', agentPath: '/root/number_reply', model: null };
const outputs = (lines: Record<string, unknown>[]) => lines.flatMap((line) => (line.type === 'response_item' ? [line.payload] : []));

describe('codex subagent activity', () => {
  it('reports an agent as one Agent call that ends with the child thread answer', () => {
    const tracker = createSubagentTracker();
    expect(tracker.activity(started)).toMatchObject([
      { item: { type: 'tool_use', id: 'call_1', name: 'Agent', arguments: { description: 'Number reply', model: 'gpt-6-luna' } } },
    ]);
    expect(tracker.activity(started)).toEqual([]);
    tracker.childMessage('t1', 'thinking about it');
    tracker.childMessage('t1', '391');
    expect(outputs(tracker.activity(completed))).toEqual([
      { type: 'function_call_output', call_id: 'call_1', name: 'Agent', output: '391' },
    ]);
    expect(tracker.activity(completed)).toEqual([]);
    expect(tracker.finish()).toEqual([]);
  });

  it('marks an interrupted agent and an agent with no answer', () => {
    const tracker = createSubagentTracker();
    tracker.activity(started);
    expect(outputs(tracker.activity({ ...completed, kind: 'interrupted' }))).toMatchObject([{ is_error: true }]);
    tracker.activity({ ...started, agentThreadId: 't2' });
    expect(outputs(tracker.activity({ ...completed, agentThreadId: 't2' }))).toMatchObject([{ is_error: true }]);
  });

  it('closes an agent that outlives the turn', () => {
    const tracker = createSubagentTracker();
    tracker.activity(started);
    expect(outputs(tracker.finish())).toMatchObject([{ call_id: 'call_1', output: 'Still running when the turn ended.' }]);
  });
});
