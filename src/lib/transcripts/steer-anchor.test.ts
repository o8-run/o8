import { expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { placeSteerTranscriptEntries, type SteerTranscriptAnchor } from './steer-anchor';
import { serializeTranscriptForStorage, deserializeStoredTranscript } from './history-serde';
import { mergeChatMessages } from '@/lib/llm/merge-chat-messages';

const anchor: SteerTranscriptAnchor = { assistantMessageId: 'answer', sequence: 1, text: 'Before.More.', blockText: 'Before.\nMore.', thinking: 'Think.', blockThinking: 'Think.', toolCount: 1 };
const steer: MobileTranscriptEntry = { id: 'composer-steer-first', role: 'user', text: 'Correction', timestamp: 2, steerAnchor: anchor };
it.each([false, true])('splits exact text and pending tool identity with block rendering %s', blocks => {
  const text = blocks ? 'Before.\nMore.\nAfter.' : 'Before.More.After.';
  const tools = [{ id: 'before', name: 'read', status: 'done' as const }, { id: 'after', name: 'check', status: 'running' as const }];
  const assistant: MobileTranscriptEntry = { id: 'answer', role: 'assistant', text, thinking: 'Think.More thought.', toolCalls: tools, receipt: { leadModel: 'original', effort: 'low', mode: 'multitask' }, tokens: { input: 5, output: 9 }, sources: [{ title: 'Once only' }] };
  const rows = placeSteerTranscriptEntries([assistant, steer]);
  expect(rows.map(row => row.role)).toEqual(['assistant', 'user', 'assistant']);
  expect(rows.filter(row => row.role === 'assistant').map(row => row.text).join('')).toBe(text);
  expect(rows[0].toolCalls).toEqual([tools[0]]); expect(rows[2].toolCalls).toEqual([tools[1]]);
  expect(rows[0].thinking).toBe('Think.'); expect(rows[2].thinking).toBe('More thought.');
  expect(rows[0].receipt).toBeUndefined(); expect(rows[2].receipt).toEqual(assistant.receipt);
  expect(rows[0].sources).toBeUndefined(); expect(rows[2].sources).toEqual(assistant.sources);
  expect(rows[0].tokens).toBeUndefined(); expect(rows[2].tokens).toEqual(assistant.tokens);
  expect(new Set(rows.map(row => row.id)).size).toBe(3);
});
it('retains immutable admission anchors through stale client saves and history serialization', () => {
  const stored = serializeTranscriptForStorage([steer]);
  const incoming = [{ ...stored[0], steerAnchor: { ...anchor, text: 'Incorrect late text' } }];
  const result = mergeChatMessages(stored, incoming);
  expect(deserializeStoredTranscript(result)[0].steerAnchor).toEqual(anchor);
});
it('keeps equal-offset steers in admission order without assigning them to an unrelated or missing turn', () => {
  const second = { ...steer, id: 'composer-steer-second', text: 'Second', timestamp: -1, steerAnchor: { ...anchor, sequence: 2 } };
  const assistant: MobileTranscriptEntry = { id: 'answer', role: 'assistant', text: 'Before.More.After.' };
  expect(placeSteerTranscriptEntries([assistant, steer, second]).map(row => row.text)).toEqual(['Before.More.', 'Correction', 'Second', 'After.']);
  expect(placeSteerTranscriptEntries([{ ...assistant, id: 'other' }, steer])).toEqual([{ ...assistant, id: 'other' }, steer]);
});
it('holds a stale partial snapshot before the steer until its existing source text catches up', () => {
  const rows = placeSteerTranscriptEntries([{ id: 'answer', role: 'assistant', text: 'Before.' }, steer]);
  expect(rows.map(row => row.text)).toEqual(['Before.', 'Correction', '']);
});
it('ignores malformed old metadata without breaking the transcript', () => {
  const invalid = { ...steer, steerAnchor: { assistantMessageId: 'answer' } as SteerTranscriptAnchor };
  expect(placeSteerTranscriptEntries([invalid])).toEqual([invalid]);
});
