import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => ({ current: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => dataDir.current }));

const { readSubagentTranscript, recordSubagentEvent, subagentSessionId } = await import('@/lib/claude-code/subagent-transcript');

const parent = 'toolu_abc';
const said = (uuid: string, content: unknown[]) => ({ type: 'assistant', uuid, parent_tool_use_id: parent, timestamp: '2026-11-02T18:10:52.949Z', message: { model: 'claude-haiku-5-5', content } });

beforeEach(() => { dataDir.current = mkdtempSync(path.join(os.tmpdir(), 'o8-subagent-')); });
afterEach(() => { rmSync(dataDir.current, { recursive: true, force: true }); });

describe('subagent transcript', () => {
  it('reads back words, tools and their results as one reply', () => {
    recordSubagentEvent(said('a', [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));
    recordSubagentEvent({ type: 'user', uuid: 'b', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done.txt' }] } });
    recordSubagentEvent(said('c', [{ type: 'text', text: 'Found it.' }]));
    const [reply, ...rest] = readSubagentTranscript(parent);
    expect(rest).toEqual([]);
    expect(reply).toMatchObject({ role: 'assistant', text: 'Checking.\n\nFound it.', model: 'claude-haiku-5-5' });
    expect(reply.toolCalls).toMatchObject([{ name: 'Bash', status: 'done', result: 'done.txt', textAt: 9 }]);
  });

  it('keeps one copy of a replayed event', () => {
    recordSubagentEvent(said('a', [{ type: 'text', text: 'Once.' }]));
    recordSubagentEvent(said('a', [{ type: 'text', text: 'Once.' }]));
    expect(readSubagentTranscript(parent)[0].text).toBe('Once.');
  });

  it('refuses an id that is not a plain tool id', () => {
    recordSubagentEvent({ ...said('a', []), parent_tool_use_id: '../escape' });
    expect(readSubagentTranscript('../escape')).toEqual([]);
  });

  it('recognizes only its own session keys', () => {
    expect(subagentSessionId('subagent:toolu_abc')).toBe('toolu_abc');
    expect(subagentSessionId('llm-chat:one')).toBeNull();
  });
});
