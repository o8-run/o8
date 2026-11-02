/**
 * Stream-event dedup — the Collide double-render fix. The trailing `assistant`
 * replay must not re-emit text that already streamed via deltas, even when the
 * replay's content array has shifted (thinking blocks) so the block index no
 * longer matches. Content-based dedup, mirroring stream-json-parser.ts.
 */

import { describe, it, expect } from 'vitest';

import { createToolCallTracker, parseOrchestratorTurnUsage, processStreamEvent, type OrchestratorEvent } from './orchestrator-stream-events';

function run(rawEvents: Array<Record<string, unknown>>): OrchestratorEvent[] {
  const out: OrchestratorEvent[] = [];
  const tracker = createToolCallTracker();
  for (const e of rawEvents) {
    processStreamEvent(e, (ev) => out.push(ev), () => {}, () => {}, tracker);
  }
  return out;
}

const textsOf = (events: OrchestratorEvent[]) =>
  events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);

describe('processStreamEvent — assistant-replay dedup', () => {
  it('does NOT double the answer when the replay block index SHIFTS (the Collide bug)', () => {
    const out = run([
      // Streamed a text delta at index 1 (a thinking block occupied index 0).
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello world' } },
      // The trailing assistant replay compacted the array — the text is now at position 0.
      // Index-based dedup missed this (hasStreamedText(0) === false) and re-emitted.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    ]);
    expect(textsOf(out)).toEqual(['Hello world']); // ONCE, not twice
  });

  it('dedupes even when deltas + replay share the same index (regression guard)', () => {
    const out = run([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part' }] } },
    ]);
    expect(textsOf(out)).toEqual(['part']);
  });

  it('STILL emits the assistant text when nothing streamed (non-SSE turn)', () => {
    const out = run([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Full answer' }] } },
    ]);
    expect(textsOf(out)).toEqual(['Full answer']);
  });
});

describe('processStreamEvent — tool_result is_error threading (turn grammar)', () => {
  it('carries is_error through to the emitted tool_result (real parser path)', () => {
    const out = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm run build' } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: 'exit 1: build failed' }] } },
    ]);
    const result = out.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', name: 'Bash', isError: true, output: 'exit 1: build failed' });
  });

  it('omits isError for a successful tool_result', () => {
    const out = run([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: 'a.ts' } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' }] } },
    ]);
    const result = out.find((e) => e.type === 'tool_result') as { isError?: boolean } | undefined;
    expect(result).toBeDefined();
    expect(result?.isError).toBeUndefined();
  });
});

describe('processStreamEvent — Claude Code terminal errors', () => {
  it('emits an error from the observed error_during_execution result frame', () => {
    const out = run([{
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your usage limit",
    }]);
    expect(out).toContainEqual({
      type: 'error',
      code: 'error_during_execution',
      error: "You've hit your usage limit",
    });
  });
});

describe('parseOrchestratorTurnUsage', () => {
  it('keeps fresh and cached input separate for a warm harness turn', () => {
    expect(parseOrchestratorTurnUsage({
      usage: {
        input_tokens: 203,
        output_tokens: 11,
        cache_read_input_tokens: 40_448,
        cache_creation_input_tokens: 0,
      },
    })).toEqual({
      inputTokens: 203,
      outputTokens: 11,
      cacheReadTokens: 40_448,
      cacheWriteTokens: 0,
    });
  });
});

describe('processStreamEvent — a real Claude turn with background agents', () => {
  const stream = (inner: Record<string, unknown>, parent?: string) => ({
    type: 'stream_event', event: inner, ...(parent ? { parent_tool_use_id: parent } : {}),
  });
  const say = (text: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const startText = stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Sort fruit' } }] } };
  const started = { type: 'system', subtype: 'task_started', tool_use_id: 'a1', is_backgrounded: true, task_type: 'local_agent' };
  const launched = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched successfully.' }] } };
  const answered = { type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status: 'completed', summary: 'apple, kiwi' };

  it('streams words as they arrive and does not repeat them from the assistant event', () => {
    const out = run([
      say('Hello '),
      say('world'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    ]);
    expect(textsOf(out)).toEqual(['Hello ', 'world']);
  });

  it('streams thinking once', () => {
    const out = run([
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } }),
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Hmm' }] } },
    ]);
    expect(out.filter((e) => e.type === 'thinking')).toHaveLength(1);
  });

  it('separates a later text block from the one before it', () => {
    expect(textsOf(run([startText, say('One.'), startText, say('Two.')])).join('')).toBe('One.\n\nTwo.');
  });

  it('keeps a subagent out of the parent reply', () => {
    const out = run([
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner' } }, 'a1'),
      { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'text', text: 'inner' }] } },
    ]);
    expect(out).toEqual([]);
  });

  it('reports the agent answer, not the launch, as the result of its call', () => {
    const out = run([call, started, launched, answered]);
    expect(out.filter((e) => e.type === 'tool_result')).toMatchObject([
      { id: 'a1', name: 'Agent', output: 'apple, kiwi' },
    ]);
  });

  it('leaves the launch of a background shell alone', () => {
    const shell = { ...started, tool_use_id: 's1', task_type: 'local_bash' };
    const ack = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Running' }] } };
    expect(run([shell, ack]).filter((e) => e.type === 'tool_result')).toMatchObject([{ id: 's1', output: 'Running' }]);
  });
});
