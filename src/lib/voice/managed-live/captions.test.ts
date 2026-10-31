import { describe, expect, it } from 'vitest';
import { LiveCaptions } from './captions';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { visibleVoiceTranscript } from '@/lib/transcripts/voice-captions';
import { dedupeDisplayMessages } from '@/components/desktop/thoughts/chat-panel/dedupe-display-messages';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { mergeChatMessages } from '@/lib/llm/merge-chat-messages';

function fixture() {
  let entries: MobileTranscriptEntry[] = [];
  const captions = new LiveCaptions('session', updates => { entries = dedupeDisplayMessages([...entries, ...updates]); });
  const delta = (id: string, text: string, start = 0, direction = 'input') => captions.observe({
    type: `session.${direction}_transcript.delta`, event_id: id, delta: text, start_ms: start, end_ms: start + 100,
  });
  return { captions, delta, entries: () => entries };
}
describe('voice captions in the existing transcript', () => {
  it('streams both speakers independently, preserves spaces and repeated words, and ignores replayed events', () => {
    const f = fixture();
    f.delta('a', 'I want'); f.delta('b', 'Sure', 50, 'output'); f.delta('c', ' to check', 110);
    f.delta('c', ' to check', 110); f.delta('d', ' check this', 220);
    expect(f.entries().map(entry => entry.text)).toEqual(['I want to check check this', 'Sure']);
    expect(f.entries()[0].voice).toMatchObject({ startMs: 0, endMs: 320 });
    expect(f.entries()[1]).not.toHaveProperty('receipt');
  });
  it('links only delegated fragments and keeps them visible until the exact regular message appears', () => {
    const f = fixture(); f.delta('a', 'Check this.'); f.delta('b', ' Also this.', 110);
    f.captions.submitted(['a'], 'orch-user-one');
    expect(visibleVoiceTranscript(f.entries()).map(entry => entry.text)).toEqual(['Check this.', ' Also this.']);
    const sent: MobileTranscriptEntry = { id: 'orch-user-one', role: 'user', text: 'Check this.' };
    expect(visibleVoiceTranscript([...f.entries(), sent]).map(entry => entry.text)).toEqual([' Also this.', 'Check this.']);
    // The next exact send can claim the remainder without erasing either stored fragment.
    f.captions.submitted(['b'], 'orch-user-two');
    expect(f.entries()).toHaveLength(2);
    expect(f.entries()[1].voice?.delegatedUserMessageId).toBe('orch-user-two');
  });
  it('keeps identical utterances and an identical CLI reply distinct through persistence', () => {
    const f = fixture(); f.delta('a', 'yes'); f.delta('b', 'yes', 3000); f.delta('c', 'done', 3500, 'output');
    const entries = [...f.entries(), { id: 'cli', role: 'assistant' as const, text: 'done' }];
    const stored = mergeChatMessages([], serializeTranscriptForStorage(entries));
    expect(deserializeStoredTranscript(stored).map(entry => entry.text)).toEqual(['yes', 'yes', 'done', 'done']);
  });
  it('preserves growing captions and their send links against stale REST and retained-state updates', () => {
    const f = fixture(); f.delta('a', 'Check'); const stale = f.entries();
    f.delta('b', ' this', 110); f.captions.submitted(['a', 'b'], 'orch-user-one');
    const stored = mergeChatMessages(serializeTranscriptForStorage(f.entries()), serializeTranscriptForStorage(stale));
    const restored = deserializeStoredTranscript(stored);
    expect(restored[0]).toMatchObject({ text: 'Check this', voice: { delegatedUserMessageId: 'orch-user-one' } });
    expect(dedupeDisplayMessages([...restored, ...stale])[0].text).toBe('Check this');
  });
  it.each(['review-user-assistant-queued-next-nonce-123', 'lead-user-exact-root'])('persists the authoritative queued transcript link: %s', userId => {
    const f = fixture(); f.delta('a', 'Queued request.'); f.captions.submitted(['a'], userId);
    const restored = deserializeStoredTranscript(serializeTranscriptForStorage(f.entries()));
    expect(restored[0].voice?.delegatedUserMessageId).toBe(userId);
    const sent: MobileTranscriptEntry = { id: userId, role: 'user', text: 'Queued request.' };
    expect(visibleVoiceTranscript([...restored, sent])).toEqual([sent]);
    expect(visibleVoiceTranscript([...restored, { ...sent, id: 'other' }])).toHaveLength(2);
  });
});
