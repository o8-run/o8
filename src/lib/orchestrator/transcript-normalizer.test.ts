import { describe, expect, it } from 'vitest';
import { normalizeCodexEvents } from './transcript-normalizer';

const TS = '2026-08-23T13:08:33.642Z';
const COMMAND = '/bin/zsh -lc "sed -n 1,40p src/lib/lane/registry.ts"';

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** The `event_msg` shape: call id lives on the payload. */
function execBegin(ts: string, callId: string, command: string): string {
  return line({ type: 'event_msg', timestamp: ts, payload: { type: 'exec_command_begin', call_id: callId, command } });
}

/** The `item.*` shape: id lives on the item, and the normalizer keys on `id\0command`. */
function itemStarted(ts: string, itemId: string, command: string): string {
  return line({ type: 'item.started', timestamp: ts, item: { type: 'command_execution', id: itemId, command } });
}

function itemCompleted(ts: string, itemId: string, command: string, output: string, exitCode: number): string {
  return line({
    type: 'item.completed',
    timestamp: ts,
    item: { type: 'command_execution', id: itemId, command, aggregated_output: output, exit_code: exitCode },
  });
}

describe('normalizeCodexEvents — one command, one row (#1845)', () => {
  it('collapses the same command announced through several stream shapes', () => {
    // Codex carries one command in both the legacy `event_msg` form and the
    // `item.*` form. Their call ids are derived differently, so an id-keyed
    // dedupe left four identical rows sharing a millisecond timestamp.
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_exec_1', COMMAND),
      itemStarted(TS, 'item_exec_1', COMMAND),
      execBegin(TS, 'call_exec_1', COMMAND),
      itemStarted(TS, 'item_exec_1', COMMAND),
      itemCompleted(TS, 'item_exec_1', COMMAND, 'export function createLane(', 0),
    ].join('\n'));

    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'tool_call', tool: 'exec_command', ts: TS });

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool: 'exec_command', ok: true });
  });

  it('keeps a genuine re-run as its own row, because its timestamp differs', () => {
    const later = '2026-08-23T13:09:41.100Z';
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_exec_1', COMMAND),
      itemCompleted(TS, 'item_exec_1', COMMAND, 'first run', 0),
      execBegin(later, 'call_exec_2', COMMAND),
      itemCompleted(later, 'item_exec_2', COMMAND, 'second run', 0),
    ].join('\n'));

    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.ts)).toEqual([TS, later]);
  });

  it('does not merge two different commands sharing a timestamp', () => {
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_a', 'git status --short'),
      execBegin(TS, 'call_b', 'npx tsc --noEmit'),
    ].join('\n'));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('keeps same-millisecond duplicate commands distinct within one stream shape', () => {
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_a', COMMAND),
      execBegin(TS, 'call_b', COMMAND),
      itemStarted(TS, 'item_a', COMMAND),
      itemStarted(TS, 'item_b', COMMAND),
    ].join('\n'));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('does not alias calls whose timestamps are missing or invalid', () => {
    const events = normalizeCodexEvents([
      line({ type: 'event_msg', timestamp: 'not-a-date', payload: { type: 'exec_command_begin', call_id: 'call_a', command: COMMAND } }),
      line({ type: 'item.started', item: { type: 'command_execution', id: 'item_a', command: COMMAND } }),
    ].join('\n'), TS);

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('uses the full arguments for alias identity, not the clipped display prefix', () => {
    const prefix = 'x'.repeat(700);
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_a', `${prefix} first`),
      itemStarted(TS, 'item_b', `${prefix} second`),
    ].join('\n'));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('keeps generated call ids unique after an alias match', () => {
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_explicit', COMMAND),
      line({ type: 'item.started', timestamp: TS, item: { type: 'command_execution', command: COMMAND } }),
      line({ type: 'item.started', timestamp: TS, item: { type: 'command_execution', command: 'git status --short' } }),
    ].join('\n'));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('returns an empty stream for empty or unparseable input', () => {
    expect(normalizeCodexEvents('')).toEqual([]);
    expect(normalizeCodexEvents('not json\n{oops')).toEqual([]);
  });
});

describe('normalizeCodexEvents — assistant replies', () => {
  const reply = (ts: string, text: string, phase = 'commentary') => line({
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text, annotations: [] }] },
  });
  const agentMessage = (ts: string, text: string) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: text } });

  it('reads a reply that a newer rollout writes only as an assistant message item', () => {
    const events = normalizeCodexEvents([
      reply('2026-11-14T22:09:27.068Z', 'I will inspect the repository.'),
      line({ timestamp: '2026-11-14T22:09:27.100Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } }),
      reply('2026-11-14T22:10:17.918Z', 'Outcome: done.', 'final_answer'),
    ].join('\n'));
    expect(events.map((event) => [event.type, event.ts, 'text' in event ? event.text : ''])).toEqual([
      ['assistant', '2026-11-14T22:09:27.068Z', 'I will inspect the repository.'],
      ['assistant', '2026-11-14T22:10:17.918Z', 'Outcome: done.'],
    ]);
  });

  it('shows a reply once when an older rollout writes it both ways', () => {
    const events = normalizeCodexEvents([
      agentMessage(TS, 'Same reply.'),
      reply(TS, 'Same reply.'),
      reply(TS, 'Another reply.'),
      agentMessage(TS, 'Another reply.'),
    ].join('\n'));
    expect(events.filter((event) => event.type === 'assistant').map((event) => ('text' in event ? event.text : ''))).toEqual(['Same reply.', 'Another reply.']);
  });

  it('still shows the same short reply again in a later turn', () => {
    const texts = (raw: string[]) => normalizeCodexEvents(raw.join('\n'))
      .filter((event) => event.type === 'assistant').map((event) => ('text' in event ? event.text : ''));
    // Older rollout: each turn writes the reply both ways.
    expect(texts([agentMessage(TS, 'Done.'), reply(TS, 'Done.'), agentMessage(TS, 'Next.'), reply(TS, 'Next.'), reply(TS, 'Done.'), agentMessage(TS, 'Done.')]))
      .toEqual(['Done.', 'Next.', 'Done.']);
    // Newer rollout: only items, so every one is shown.
    expect(texts([reply(TS, 'Done.'), reply(TS, 'Done.')])).toEqual(['Done.', 'Done.']);
    // Older events alone: every one is shown.
    expect(texts([agentMessage(TS, 'Done.'), agentMessage(TS, 'Done.')])).toEqual(['Done.', 'Done.']);
  });

  it('pairs a reply whose item splits it into parts', () => {
    const split = line({ timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: 'First part.' }, { type: 'output_text', text: 'Second part.' },
    ] } });
    const events = normalizeCodexEvents([agentMessage(TS, 'First part.\nSecond part.'), split].join('\n'));
    expect(events.filter((event) => event.type === 'assistant')).toHaveLength(1);
  });
});
