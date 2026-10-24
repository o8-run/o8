import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { codexParseRunLog } from '@/lib/codex/owned-log';
import { parseClaudeOwnedRunLog } from '@/lib/claude-code/owned-log';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
const fixture = vi.hoisted(() => ({ transcript: [] as unknown[] }));
vi.mock('@/lib/runtimes', () => ({ getRuntime: () => ({ capabilities: { readTranscript: true }, readTranscript: async () => fixture.transcript }) }));
vi.mock('@/lib/orchestrator/packet-transcript', () => ({ readSessionSteerTranscriptEvents: () => [] }));
const { GET } = await import('./route');
const run: OwnedRunRecord = { id: 'usage-run', mode: 'launch', prompt: 'Inspect fixture', startedAt: '2026-10-24T10:00:00Z',
  finishedAt: '2026-10-24T10:01:00Z', pid: 123, stdoutPath: '/fixture/stdout', stderrPath: '/fixture/stderr', outcome: 'finished' };
it.each(['codex', 'claude-code'])('carries real %s log cache evidence through the runtime transcript HTTP entry point', async runtime => {
  const raw = runtime === 'codex' ? [
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Fixture answer' } },
    { type: 'turn.completed', model: 'fixture-model', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 } },
  ] : [
    { type: 'assistant', message: { model: 'fixture-model', content: [{ type: 'text', text: 'Fixture answer' }] } },
    { type: 'result', result: 'Fixture answer', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10,
      cache_creation_input_tokens: 0 } },
  ];
  const parsed = (runtime === 'codex' ? codexParseRunLog : parseClaudeOwnedRunLog)(raw.map(row => JSON.stringify(row)).join('\n'), run);
  fixture.transcript = ownedTailToRuntimeTranscript({ entries: [], groups: [{ ...run, title: 'Fixture', summary: '',
    entries: parsed.entries }] });
  const response = await GET(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${runtime}-owned:usage`));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.transcript.find((entry: { tokens?: unknown }) => entry.tokens)).toMatchObject({
    role: 'assistant', model: 'fixture-model', timestamp: Date.parse(run.finishedAt!),
    tokens: { input: 100, output: 10, cacheRead: 900 },
  });
});

it.each(['codex', 'claude-code'])('keeps %s historical model unknown when its log does not report one', async runtime => {
  const raw = runtime === 'codex' ? [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 } },
  ] : [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }] } },
    { type: 'result', result: 'Answer', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10 } },
  ];
  const parsed = (runtime === 'codex' ? codexParseRunLog : parseClaudeOwnedRunLog)(raw.map(row => JSON.stringify(row)).join('\n'), run);
  fixture.transcript = ownedTailToRuntimeTranscript({ entries: [], groups: [{ ...run, title: 'Fixture', summary: '', entries: parsed.entries }] });
  const payload = await (await GET(new NextRequest(`http://localhost/api/runtime/transcript?sessionKey=${runtime}-owned:usage`))).json();
  expect(payload.transcript.find((entry: { tokens?: unknown }) => entry.tokens).model).toBeUndefined();
});
