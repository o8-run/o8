import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-cache-producer-'));
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = root;
  return { root, previousHome, rollout: path.join(root, 'sessions', 'turn.jsonl') };
});
vi.mock('@/lib/codex/discovery-store', () => ({
  defaultCodexHome: () => fixture.root, listCodexDiscoveryHomes: async () => [{ configHomeRef: fixture.root }],
  queryCodexThreadByIdFromHome: async () => ({ id: 'fixture', cwd: fixture.root, title: 'Fixture', updated_at: 1, rollout_path: fixture.rollout }),
  codexSessionsRoot: () => path.join(fixture.root, 'sessions'),
}));
vi.mock('@/lib/codex/live-process-discovery', () => ({ buildCodexActivityMap: async () => new Map(), queryAllLiveCodexProcesses: async () => new Map() }));
const { claudeCodeRuntime } = await import('./claude-code');
const { getCodexRuntimeTail } = await import('@/lib/codex/sessions');
afterAll(() => { if (fixture.previousHome === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = fixture.previousHome; rmSync(fixture.root, { recursive: true, force: true }); });
const write = (file: string, rows: unknown[]) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n')); };
it('retains unique API-call usage when discovered Claude narration is coalesced', async () => {
  const user = { type: 'user', uuid: 'user-1', timestamp: '2026-10-24T10:00:00Z', message: { content: 'Question' } };
  const assistant = (id: string, uuid: string, read: number) => ({ type: 'assistant', uuid, timestamp: '2026-10-24T10:01:00Z',
    message: { id, model: 'fixture-model', content: [{ type: 'text', text: 'Answer' }], usage: { input_tokens: 100,
      output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } } });
  write(path.join(fixture.root, 'projects', 'repo', 'fixture.jsonl'), [{ type: 'system', subtype: 'init' }, user, assistant('api-1', 'block-1', 0),
    assistant('api-1', 'block-2', 0), assistant('api-2', 'block-3', 900)]);
  const rows = await claudeCodeRuntime.readTranscript('claude-code:fixture');
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ model: 'fixture-model', tokens: { input: 200, output: 20, cacheRead: 900, cacheWrite: 0 } });
});
it('uses cumulative Codex turn deltas, excludes user rows, and retains identity across a sliding tail', async () => {
  const count = (input: number, read: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: read, output_tokens: input / 10 },
    last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
  } } });
  const message = (role: string, time: string) => ({ type: 'response_item', timestamp: time, payload: { type: 'message', role,
    content: [{ type: 'output_text', text: 'Fixture' }] } });
  const rows = [count(1000, 900), { type: 'turn_context', payload: { model: 'fixture-model' } },
    message('user', '2026-10-24T10:00:00Z'), count(1000, 900), message('assistant', '2026-10-24T10:01:00Z'),
    count(2000, 1800), count(3000, 2700), message('assistant', '2026-10-24T10:02:00Z'), count(4000, 3600)];
  write(fixture.rollout, rows);
  const first = (await getCodexRuntimeTail('codex:fixture')).entries;
  expect(first.filter(row => row.tokens)).toHaveLength(1);
  expect(first.at(-1)).toMatchObject({ model: 'fixture-model', tokens: { input: 300, cacheRead: 2700, cacheWrite: 0, output: 300 } });
  const totals = first.at(-1)!.tokens!;
  expect(totals.input + totals.cacheRead! + totals.cacheWrite!).toBe(3000);
  expect(first.find(row => row.role === 'user')?.tokens).toBeUndefined();
  write(fixture.rollout, [{ type: 'response_item', payload: { type: 'function_call', name: 'old-tool' } }, ...rows]);
  const second = (await getCodexRuntimeTail('codex:fixture')).entries;
  expect(second.find(row => row.role === 'user')?.id).toBe(first.find(row => row.role === 'user')?.id);
});
