import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

const fixture = vi.hoisted(() => ({ events: [] as TranscriptEvent[] }));
vi.mock('@/lib/orchestrator/packet-transcript', () => ({
  readSessionTranscriptEvents: async (sessionKey: string) => ({
    sessionKey, runtime: 'claude-code', events: fixture.events,
    historyComplete: false, earliestEventTime: '2026-01-01T00:00:02Z',
  }),
  readPacketTranscriptEvents: vi.fn(),
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipalContext: () => null, workerPacketRefusal: () => null }));
vi.mock('@/lib/lane/registry', () => ({ findLaneBySession: () => null }));
const { GET } = await import('@/app/api/orchestrator/packet-transcript/route');
async function read(cursor = 0, cursorToken = '') {
  const query = new URLSearchParams({ sessionKey: 'fixture:worker', cursor: String(cursor), cursorToken });
  const response = await GET(new NextRequest(`http://localhost/api/orchestrator/packet-transcript?${query}`));
  expect(response.status).toBe(200);
  return response.json();
}
const answer = (seq: number, text: string): TranscriptEvent => ({ seq, ts: '2026-01-01T00:00:02Z', type: 'assistant', text });

describe('native worker cursor checkpoints', () => {
  it('keeps answer identity and resets pagination when a steer is inserted before the cursor', async () => {
    fixture.events = [answer(1, 'Final answer')];
    const first = await read();
    expect(first.events[0].eventId).toEqual(expect.any(String));
    fixture.events = [{ seq: 1, ts: '2026-01-01T00:00:01Z', type: 'steer', source: 'operator', text: 'Check again' }, answer(2, 'Final answer')];
    const next = await read(first.nextCursor, first.cursorToken);
    expect(next.cursorReset).toBe(true);
    expect(next.events.map((e: { type: string }) => e.type)).toEqual(['steer', 'assistant']);
    expect(next.events[1].eventId).toBe(first.events[0].eventId);
  });
  it('detects a sliding tail even when it shrinks and later regrows to the same length', async () => {
    fixture.events = [answer(1, 'Old'), answer(2, 'Overlap')];
    const first = await read();
    fixture.events = [answer(1, 'Overlap')];
    const slide = await read(first.nextCursor, first.cursorToken);
    expect(slide.cursorReset).toBe(true);
    expect(slide.nextCursor).toBe(1);
    fixture.events.push(answer(2, 'New'));
    const next = await read(slide.nextCursor, slide.cursorToken);
    expect(next.events.map((e: { text: string }) => e.text)).toEqual(['New']);
    expect(next.historyComplete).toBe(false);
    expect(next.earliestEventTime).toBe('2026-01-01T00:00:02Z');
  });
});

it('keeps the legacy event shape when cursorToken is absent', async () => {
  fixture.events = [answer(1, 'Legacy answer')];
  const response = await GET(new NextRequest('http://localhost/api/orchestrator/packet-transcript?sessionKey=fixture:worker'));
  expect((await response.json()).events).toEqual(fixture.events);
});

it('keeps identical unstamped calls distinct across a lane insertion', async () => {
  const call = { type: 'tool_call' as const, tool: 'exec_command', args: '{}', summary: 'Check', ts: '' };
  fixture.events = [{ ...call, seq: 1 }, { ...call, seq: 2 }];
  const first = await read();
  expect(new Set(first.events.map((e: { eventId: string }) => e.eventId)).size).toBe(2);
  fixture.events = [{ seq: 1, ts: '2026-01-01T00:00:01Z', type: 'steer', source: 'operator', text: 'Continue' }, { ...call, seq: 2 }, { ...call, seq: 3 }];
  const inserted = await read(first.nextCursor, first.cursorToken);
  expect(inserted.events.slice(1).map((e: { eventId: string }) => e.eventId))
    .toEqual(first.events.map((e: { eventId: string }) => e.eventId));
});

it('keeps null for empty and exhausted legacy readbacks', async () => {
  fixture.events = [];
  expect(await read()).toMatchObject({ events: [], nextCursor: null });
  fixture.events = [answer(1, 'Done')];
  const legacy = await GET(new NextRequest('http://localhost/api/orchestrator/packet-transcript?sessionKey=fixture:worker&cursor=1'));
  expect(await legacy.json()).toMatchObject({ events: [], nextCursor: null });
});

it('does not use a normalizer positional fallback call id as durable identity', async () => {
  const call = { seq: 1, ts: '2026-01-01T00:00:02Z', type: 'tool_call' as const, tool: 'read', args: '{}', summary: 'Read' };
  fixture.events = [{ ...call, callId: 'tool-2' }];
  const first = await read();
  fixture.events = [{ ...call, callId: 'tool-1' }];
  const slid = await read(first.nextCursor, first.cursorToken);
  expect(slid.cursorReset).toBe(true);
  expect(slid.events[0].eventId).toBe(first.events[0].eventId);
});

it('prefers a durable runtime event id when streamed arguments change', async () => {
  const call = { seq: 1, ts: '', type: 'tool_call' as const, callId: 'native-call-42', tool: 'read', args: '{', summary: 'Read' };
  fixture.events = [Object.assign(call, { eventId: 'runtime-offset-42' })];
  const first = await read();
  fixture.events = [Object.assign({ ...call, args: '{}', summary: 'Read file' }, { eventId: 'runtime-offset-42' })];
  const changed = await read(first.nextCursor, first.cursorToken);
  expect(changed.cursorReset).toBe(true);
  expect(changed.events[0].eventId).toBe(first.events[0].eventId);
});

it('retains native assistant event ids while keeping legacy normalizer output unchanged', async () => {
  const { normalizeClaudeCodeEvents } = await import('@/lib/orchestrator/transcript-normalizer-multi');
  const raw = JSON.stringify({ type: 'assistant', uuid: 'native-message-42', message: { content: [{ type: 'text', text: 'Answer' }] } });
  expect(normalizeClaudeCodeEvents(raw, '')[0]).not.toHaveProperty('eventId');
  expect(normalizeClaudeCodeEvents(raw, '', true)[0]).toHaveProperty('eventId', 'native-message-42:assistant');
});
