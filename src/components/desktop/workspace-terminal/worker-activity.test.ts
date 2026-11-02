import { describe, expect, it } from 'vitest';
import { humanizeActivity, workerTranscriptBlocks } from './worker-activity';
import { codexParseRunLog } from '@/lib/codex/owned-log';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import { normalizeCodexEvents } from '@/lib/orchestrator/transcript-normalizer';
import { mapPacketTranscriptEntries } from './use-packet-transcript-poll';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const run: OwnedRunRecord = { id: 'run', mode: 'launch', prompt: 'Inspect', startedAt: '2026-10-23T12:00:00Z', pid: 1, stdoutPath: '/tmp/log', stderrPath: '/tmp/err', outcome: 'running' };
const log = (type: string, id: string, extra = {}) => JSON.stringify({ type, timestamp: '2026-10-23T12:00:00Z', item: { id, type: 'command_execution', command: "/bin/zsh -lc 'cat src/router.ts'", ...extra } });
const tool = (id: string, status: 'running' | 'done' | 'error' = 'done'): MobileTranscriptEntry => ({ id: `entry-${id}-${status}`, role: 'tool', text: '', timestamp: 1000, toolCalls: [{ id, name: 'exec_command', args: { command: 'cat src/router.ts' }, status }] });

describe('activity humanizer', () => {
  it.each([
    ["/bin/zsh -lc 'cat src/router.ts'", 'Read router.ts', ['src/router.ts']],
    ['bash -lc "git diff --stat"', 'Checked the diff', []],
    ['sh -c "git status --short"', 'Checked status', []],
    ['git log -5', 'Checked history', []],
    ['sed -n \'1,20p\' src/a.ts', 'Read a.ts', ['src/a.ts']],
    ['rg -n "some phrase" src/a.ts src/b.ts', 'Searched the codebase', ['src/a.ts', 'src/b.ts']],
    ['ls src', 'Listed files', []],
    ['npm test -- --run', 'Ran tests', []],
    ['npx vitest run', 'Ran tests', []],
    ['cargo test', 'Ran tests', []],
    ['npx tsc --noEmit', 'Type-checked', []],
    ['npx eslint src/a.ts', 'Linted', ['src/a.ts']],
    ['cd repo && npm run test:unit', 'Ran tests', []],
    ['python scripts/check.py', 'Ran python', ['scripts/check.py']],
  ])('humanizes %s', (command, label, files) => {
    expect(humanizeActivity({ name: 'Bash', args: { command } })).toMatchObject({ label, files });
  });
  it('handles native tools, array wrappers, spaced paths and patches', () => {
    expect(humanizeActivity({ name: 'Read', args: { file_path: 'src/a file.ts' } }).files).toEqual(['src/a file.ts']);
    expect(humanizeActivity({ name: 'shell', args: { command: ['/bin/bash', '-lc', 'head src/a.ts'] } }).label).toBe('Read a.ts');
    expect(humanizeActivity({ name: 'apply_patch', args: { input: '*** Update File: src/a.ts\n@@\n-old\n+new' } }).label).toBe('Edited a.ts');
    expect(humanizeActivity({ name: 'exec_command', args: { command: 'npm test' } }).liveLabel).toBe('Running tests');
  });
});

describe('command identity through log and packet entry points', () => {
  it('folds separate start/completion events into one settled runtime row', () => {
    const raw = [log('item.started', 'a'), log('item.completed', 'a', { exit_code: 1, aggregated_output: 'Permission denied' })].join('\n');
    const entries = codexParseRunLog(raw, run).entries.filter(entry => entry.kind === 'tool' || entry.kind === 'tool-output');
    expect(entries.map(entry => entry.id)).toEqual(['run:tool:a', 'run:tool-output:a']);
    for (const entry of entries) {
      expect(entry.toolCall).toMatchObject({ id: 'run:a', status: 'error', result: 'Permission denied' });
    }
    const transcript = ownedTailToRuntimeTranscript({ entries, groups: [] });
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'run:tool:a', role: 'assistant',
      toolCalls: [{ id: 'run:a', status: 'error', result: 'Permission denied' }],
    });
  });
  it('retains a stable owned identity while running', () => {
    const start = codexParseRunLog(log('item.started', 'a'), run).entries.find(entry => entry.kind === 'tool')!;
    const parsed = codexParseRunLog([log('item.started', 'a'), log('item.completed', 'a', { exit_code: 0 })].join('\n'), run);
    const done = parsed.entries.find(entry => entry.kind === 'tool')!;
    expect(start.id).toBe(done.id);
    expect(start.toolCall?.status).toBe('running');
    expect(done.toolCall?.status).toBe('done');
    const transcript = ownedTailToRuntimeTranscript({ entries: parsed.entries, groups: [] }).filter(entry => entry.toolCalls?.length);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ id: start.id, toolCalls: [{ id: 'run:a', status: 'done' }] });
  });
  it('pairs concurrent identical tools by item id across intervening prose', () => {
    const raw = [log('item.started', 'a'), log('item.started', 'b'), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Checking both.' } }), log('item.completed', 'a', { exit_code: 1, aggregated_output: 'denied' }), log('item.completed', 'b', { exit_code: 0 })].join('\n');
    const entries = mapPacketTranscriptEntries(normalizeCodexEvents(raw, run.startedAt));
    const blocks = workerTranscriptBlocks(entries, false);
    const steps = blocks.flatMap(block => block.kind === 'activity' ? block.steps : []);
    expect(steps).toHaveLength(2);
    expect(steps.map(step => step.status)).toEqual(['failed', 'ok']);
    expect(steps[0].reason).toContain('denied');
  });
});

describe('activity collapse', () => {
  it('folds activity before prose, preserves prose and leaves the live tail open', () => {
    const blocks = workerTranscriptBlocks([tool('a'), { id: 'prose', role: 'assistant', text: 'Found it.' }, tool('b', 'running')], true);
    expect(blocks.map(block => block.kind)).toEqual(['activity', 'message', 'activity']);
    expect(blocks[0]).toMatchObject({ live: false });
    expect(blocks[2]).toMatchObject({ live: true });
  });
  it('updates a repeated tool id without collapsing distinct identical commands', () => {
    const blocks = workerTranscriptBlocks([tool('a', 'running'), tool('b'), tool('a', 'error')], false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ failed: 1, summary: 'Read 1 file', live: false });
    if (blocks[0].kind === 'activity') expect(blocks[0].steps).toHaveLength(2);
  });
  it('keeps operator boundaries and does not mutate input', () => {
    const entries = [tool('a'), { id: 'operator', role: 'user' as const, text: 'Continue' }, tool('b')];
    const before = JSON.stringify(entries);
    expect(workerTranscriptBlocks(entries, false).map(block => block.kind)).toEqual(['activity', 'message', 'activity']);
    expect(JSON.stringify(entries)).toBe(before);
  });
  it('puts attached tools before their assistant prose and preserves failed status', () => {
    const blocks = workerTranscriptBlocks([{ ...tool('a', 'error'), role: 'assistant', text: 'The check failed.' }], false);
    expect(blocks.map(block => block.kind)).toEqual(['activity', 'message']);
    expect(blocks[0]).toMatchObject({ failed: 1 });
  });
});

it('preserves markdown line breaks through the packet normalization boundary', () => {
  const text = '# Result\n\n- First\n- Second\n\n```ts\nconst ready = true;\n```';
  const events = normalizeCodexEvents(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  expect(mapPacketTranscriptEntries(events)[0].text).toBe(text);
});

it('merges native tool items and pairs legacy function results through the shared owned entry point', async () => {
  const { ownedTailToRuntimeTranscript } = await import('@/lib/runtimes/shared/owned-transcript');
  const raw = [
    { type: 'item.started', item: { id: 'read', type: 'tool_use', name: 'read_file', input: { path: 'src/router.ts' } } },
    { type: 'item.completed', item: { id: 'read', type: 'tool_use', name: 'read_file', input: { path: 'src/router.ts' }, output: 'source' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'shell', name: 'exec_command', arguments: '{"command":"npm test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'shell', output: 'denied', is_error: true } },
  ].map(event => JSON.stringify(event)).join('\n');
  const parsed = codexParseRunLog(raw, run);
  const transcript = ownedTailToRuntimeTranscript({ entries: parsed.entries, groups: [] });
  const tools = transcript.flatMap(entry => entry.toolCalls ?? []);
  expect(tools).toHaveLength(2);
  expect(tools.map(tool => tool.status)).toEqual(['done', 'error']);
  expect(tools[1]).toMatchObject({ name: 'exec_command', result: 'denied' });
});
