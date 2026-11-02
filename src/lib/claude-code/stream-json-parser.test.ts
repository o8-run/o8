/**
 * Assistant-replay dedup regression (2026-06-11).
 *
 * With `--include-partial-messages`, text streams as stream_event-wrapped
 * content_block_delta frames and the final `assistant` message is a replay.
 * The old dedup matched on block INDEX — but the replayed content array
 * compacts when thinking blocks are present (text streamed at index 1
 * replays at position 0), so the replay re-emitted and doubled
 * state.fullResponse. Every non-SSE consumer of the warm REPL pool (MCP
 * cortex_ask, `o8 ask`) returned doubled answers. The fix skips the replay
 * whenever ANY text already streamed this turn.
 */

import { describe, expect, it } from 'vitest';

import { createClaudeCodeStreamJsonParser } from '@/lib/claude-code/stream-json-parser';

function lines(...events: unknown[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

const wrap = (event: unknown) => ({ type: 'stream_event', event });

describe('stream-json parser assistant-replay dedup', () => {
  it('resets text and thinking replay deduplication at each provider message', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      wrap({ type: 'message_start' }),
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first thought' } }),
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'first answer' } }),
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'first thought' }, { type: 'text', text: 'first answer' }] } },
      wrap({ type: 'message_start' }),
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'second thought' } }),
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'second answer' } }),
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'second thought' }, { type: 'text', text: 'second answer' }] } },
    ));

    expect(events.filter((event) => event.type === 'delta')).toEqual([
      expect.objectContaining({ text: 'first answer', messageIndex: 1, blockIndex: 1 }),
      expect.objectContaining({ text: 'second answer', messageIndex: 2, blockIndex: 1 }),
    ]);
    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      expect.objectContaining({ text: 'first thought', messageIndex: 1, blockIndex: 0 }),
      expect.objectContaining({ text: 'second thought', messageIndex: 2, blockIndex: 0 }),
    ]);
  });

  it('skips the replay even when thinking blocks shift the content array', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      // Thinking is block 0, text streams at block index 1...
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }),
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }),
      // ...but the replayed assistant message compacts text to position 0.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      // REPL result event without a `result` string → done falls back to fullResponse.
      { type: 'result', session_id: 's1' },
    ));

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello world');

    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('Hello world');
    expect(parser.getState().fullResponse).toBe('Hello world');
  });

  it('still emits assistant text when nothing streamed (partial messages off)', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'One blob' }] } },
      { type: 'result', result: 'One blob' },
    ));

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('One blob');

    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('One blob');
  });

  it('prefers the result event text when present', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      { type: 'result', result: 'final canonical text' },
    ));
    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('final canonical text');
  });
});

describe('stream-json parser subagents', () => {
  it('keeps a subagent out of its parent reply and keeps its result on the parent call', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const inside = { parent_tool_use_id: 'agent-1' };
    const events = parser.pushChunk(lines(
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Started it.' } }),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Sum' } }] } },
      { ...wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '391' } }), ...inside },
      { type: 'assistant', ...inside, message: { content: [
        { type: 'text', text: '391' },
        { type: 'tool_use', id: 'inner', name: 'Bash', input: {} },
      ] } },
      { type: 'user', ...inside, message: { content: [{ type: 'tool_result', tool_use_id: 'inner', content: 'ok' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: '391' }] } },
      { type: 'result', result: 'Done.' },
    ));
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : []));
    expect(text).toEqual(['Started it.']);
    const tools = events.flatMap((e) => (e.type === 'tool_call' ? [e.id] : []));
    expect(tools).toEqual(['agent-1']);
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e.id] : []));
    expect(results).toEqual(['agent-1']);
  });
});

describe('stream-json parser background agents', () => {
  const started = { type: 'system', subtype: 'task_started', tool_use_id: 'agent-1', is_backgrounded: true, task_type: 'local_agent' };
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Sum' } }] } };
  const launched = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'Async agent launched successfully.' }] } };
  const answered = { type: 'system', subtype: 'task_notification', tool_use_id: 'agent-1', status: 'completed', summary: '391' };
  const requesting = { type: 'system', subtype: 'status', status: 'requesting' };
  const say = (text: string) => wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  const results = (events: ReturnType<ReturnType<typeof createClaudeCodeStreamJsonParser>['pushChunk']>) =>
    events.flatMap((e) => (e.type === 'tool_result' ? [e] : []));

  it('reports the answer, not the launch, and keeps the turn open until the model reads it', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const first = parser.pushChunk(lines(call, started, launched, say('Started.'), { type: 'result', result: 'Started.' }));
    expect(results(first)).toEqual([]);
    expect(first.some((e) => e.type === 'done')).toBe(false);

    const second = parser.pushChunk(lines(answered, requesting, say('It is 391.'), { type: 'result', result: 'It is 391.' }));
    expect(results(second)).toMatchObject([{ id: 'agent-1', name: 'Agent', output: '391' }]);
    expect(second.find((e) => e.type === 'done')).toMatchObject({ text: 'Started.It is 391.' });
  });

  it('holds the turn when the answer lands before the first result', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const first = parser.pushChunk(lines(call, started, launched, answered, { type: 'result', result: 'Started.' }));
    expect(first.some((e) => e.type === 'done')).toBe(false);
    const second = parser.pushChunk(lines(requesting, { type: 'result', result: '391' }));
    expect(second.some((e) => e.type === 'done')).toBe(true);
  });

  it('ends with one result when a later request already carried the answer', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(call, started, launched, answered, requesting, { type: 'result', result: '391' }));
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('marks a failed agent and never holds a failed turn', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const failed = parser.pushChunk(lines(call, started, launched, { ...answered, status: 'failed', summary: 'boom' }));
    expect(results(failed)).toMatchObject([{ id: 'agent-1', isError: true }]);
    const running = createClaudeCodeStreamJsonParser();
    const end = running.pushChunk(lines(call, started, launched, { type: 'result', subtype: 'error_during_execution', is_error: true }));
    expect(end.some((e) => e.type === 'done')).toBe(true);
  });

  it('reports the final text when both results arrive together at the end', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      call, started, launched, say('Started.'), answered, requesting, say('It is 391.'),
      { type: 'result', result: 'Started.' }, { type: 'result', result: 'It is 391.' },
    ));
    expect(events.filter((e) => e.type === 'done')).toMatchObject([{ text: 'Started.It is 391.' }]);
  });

  it('does not hold a turn for a background shell', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const shell = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell-1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } };
    const events = parser.pushChunk(lines(
      shell,
      { ...started, tool_use_id: 'shell-1', task_type: 'local_bash' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell-1', content: 'Running in the background' }] } },
      { type: 'result', result: 'Started the server.' },
    ));
    expect(results(events)).toMatchObject([{ id: 'shell-1' }]);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'Started the server.' });
  });

  it('ends a held turn with what it said when nothing more will arrive', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const held = parser.pushChunk(lines(call, started, launched, say('Started.'), { type: 'result', result: 'Started.', usage: { input_tokens: 5, output_tokens: 2 } }));
    expect(held.filter((e) => e.type === 'usage')).toHaveLength(1);
    const end = parser.flush();
    expect(end.filter((e) => e.type === 'usage')).toEqual([]);
    expect(end.filter((e) => e.type === 'done')).toMatchObject([{ text: 'Started.' }]);
    expect(end.find((e) => e.type === 'done')).not.toHaveProperty('isError');
  });

  it('does not call an agent someone stopped a failure', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(call, started, launched, { ...answered, status: 'stopped', summary: 'Stopped' }));
    expect(results(events)).toHaveLength(1);
    expect(results(events)[0]).not.toHaveProperty('isError', true);
  });

  it('leaves a foreground agent alone', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(call, { ...started, is_backgrounded: false }, { ...launched }, { type: 'result', result: 'ok' }));
    expect(results(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('stream-json parser usage truth', () => {
  it('preserves cache reads and writes on usage and terminal events', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines({
      type: 'result',
      result: 'done',
      session_id: 'warm-session',
      total_cost_usd: 0.224909,
      usage: {
        input_tokens: 203,
        output_tokens: 11,
        cache_read_input_tokens: 40_448,
        cache_creation_input_tokens: 32,
      },
    }));

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 203,
      outputTokens: 11,
      cacheReadTokens: 40_448,
      cacheWriteTokens: 32,
      costUsd: 0.224909,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      sessionId: 'warm-session',
      cacheReadTokens: 40_448,
      cacheWriteTokens: 32,
    }));
  });
});

describe('stream-json parser provider terminal truth', () => {
  it.each([true, false])('waits past message stops for the outer result (failure: %s)', (failed) => {
    const parser = createClaudeCodeStreamJsonParser();
    const intermediate = parser.pushChunk(lines(
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading context.' } }),
      wrap({ type: 'message_stop' }),
      { type: 'message_stop' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 58_671 } },
      wrap({ type: 'message_stop' }),
    ));
    expect(intermediate.filter((event) => event.type === 'done')).toEqual([]);
    expect(parser.flush().filter((event) => event.type === 'done')).toEqual([]);
    const terminal = parser.pushChunk(lines({
      type: 'result', subtype: 'success', is_error: failed,
      result: failed ? 'Context refill limit reached' : 'Complete finding',
      session_id: 'streamed-terminal',
    })).filter((event) => event.type === 'done');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      type: 'done', subtype: 'success', sessionId: 'streamed-terminal',
      text: failed ? 'Context refill limit reached' : 'Complete finding',
      ...(failed ? { isError: true } : {}),
    });
    if (!failed) expect(terminal[0]).not.toHaveProperty('isError');
  });

  it.each([
    {
      name: 'is_error with an empty result',
      event: { type: 'result', subtype: 'success', is_error: true, result: '' },
      expectedText: '',
    },
    {
      name: 'a non-success result subtype',
      event: { type: 'result', subtype: 'error_during_execution', result: 'provider failed' },
      expectedText: 'provider failed',
    },
  ])('marks $name as failed', ({ event, expectedText }) => {
    const parser = createClaudeCodeStreamJsonParser();
    const done = parser.pushChunk(lines(event)).find((entry) => entry.type === 'done');

    expect(done).toMatchObject({ type: 'done', isError: true, text: expectedText });
  });

  it('preserves partial assistant text when the provider error result is empty', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial finding' } }),
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' },
    ));

    expect(events.find((entry) => entry.type === 'done')).toMatchObject({
      type: 'done',
      isError: true,
      subtype: 'error_during_execution',
      text: 'partial finding',
    });
  });

  it('keeps a clean success successful', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const done = parser.pushChunk(lines({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'complete',
    })).find((entry) => entry.type === 'done');

    expect(done).toEqual(expect.objectContaining({
      type: 'done',
      subtype: 'success',
      text: 'complete',
    }));
    expect(done).not.toHaveProperty('isError');
  });
});
