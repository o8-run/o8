import { describe, expect, it, vi } from 'vitest';
import { handleCodexJsonLine, type CodexLineHandlerState } from './codex-orchestrator-events';

describe('Codex orchestrator error events', () => {
  it('emits the real turn.failed quota message from the CLI JSON stream', () => {
    const onEvent = vi.fn();
    const parsed = handleCodexJsonLine(JSON.stringify({
      type: 'turn.failed',
      error: {
        code: 'usage_limit_reached',
        message: 'You have hit your usage limit. Try again when it resets.',
      },
    }), { threadId: null, cost: null }, onEvent, { isLocalModel: false });

    expect(parsed).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      error: 'You have hit your usage limit. Try again when it resets.',
      code: 'usage_limit_reached',
    });
  });

  it('puts a paragraph break between separate messages in one turn', () => {
    const state: CodexLineHandlerState = { threadId: null, cost: null };
    const onEvent = vi.fn();
    const message = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: text, text } });

    handleCodexJsonLine(message('I will compare the two.'), state, onEvent, { isLocalModel: false });
    handleCodexJsonLine(message('The roadmap is clear.'), state, onEvent, { isLocalModel: false });

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'text', text: 'I will compare the two.' },
      { type: 'text', text: '\n\nThe roadmap is clear.' },
    ]);
  });

  it('shows a command when it starts and reports only its result when it ends', () => {
    const state: CodexLineHandlerState = { threadId: null, cost: null };
    const onEvent = vi.fn();
    const line = (type: string, item: object) => JSON.stringify({ type, item });
    const events = () => onEvent.mock.calls.map(([event]) => event);

    handleCodexJsonLine(line('item.started', { type: 'command_execution', id: 'c1', command: 'npm test' }), state, onEvent, { isLocalModel: false });
    // The command is visible while it runs: nothing has completed yet.
    expect(events()).toEqual([{ type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'npm test' } }]);

    handleCodexJsonLine(line('item.completed', { type: 'command_execution', id: 'c1', command: 'npm test', output: '' }), state, onEvent, { isLocalModel: false });
    // One row, not two, and it is closed even when the command printed nothing.
    expect(events()).toEqual([
      { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'npm test' } },
      { type: 'tool_result', id: 'c1', name: 'shell', output: '' },
    ]);
  });

  it('still lists a command whose start was never announced', () => {
    const state: CodexLineHandlerState = { threadId: null, cost: null };
    const onEvent = vi.fn();
    handleCodexJsonLine(JSON.stringify({ type: 'item.started', item: { type: 'commandExecution', id: 'c2' } }), state, onEvent, { isLocalModel: false });
    handleCodexJsonLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'c2', command: 'ls', output: 'a\nb' } }), state, onEvent, { isLocalModel: false });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'tool_use', id: 'c2', name: 'shell', input: { command: 'ls' } },
      { type: 'tool_result', id: 'c2', name: 'shell', output: 'a\nb' },
    ]);
  });

  it('retains fresh, cached, and output token truth from a completed turn', () => {
    const state: CodexLineHandlerState = { threadId: null, cost: null };

    handleCodexJsonLine(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 40_651,
        cached_input_tokens: 40_448,
        output_tokens: 11,
      },
    }), state, vi.fn(), { isLocalModel: false });

    expect(state).toMatchObject({
      usage: {
        inputTokens: 203,
        outputTokens: 11,
        cacheReadTokens: 40_448,
        cacheWriteTokens: 0,
      },
    });
  });
});
