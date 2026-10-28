import { describe, it, expect } from 'vitest';
import { mergeChatMessages } from './merge-chat-messages';

const msg = (
  id: string,
  role: string,
  timestamp: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ id, role, timestamp, content: `${role}:${id}`, ...extra });

describe('mergeChatMessages (#1282 transcript-loss)', () => {
  it('retains distinct acknowledged steer identities with identical text through a stale save', () => {
    const first = msg('composer-steer-queue-first', 'user', 100, { content: 'Keep going' });
    const second = msg('composer-steer-queue-second', 'user', 200, { content: 'Keep going' });
    expect(mergeChatMessages([first, second], [first]).map(entry => entry.id)).toEqual([first.id, second.id]);
    expect(mergeChatMessages([], [first, second]).map(entry => entry.id)).toEqual([first.id, second.id]);
  });
  it('preserves a stored assistant reply when inbound is the user-only partial (THE bug)', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100)]; // mobile missed the assistant output event
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']); // reply survives
  });

  it('an empty/partial inbound can NEVER wipe the stored transcript', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    expect(mergeChatMessages(existing, []).map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('reinserts a preserved reply chronologically (interleaved partial)', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 150), msg('u2', 'user', 200)];
    const inbound = [msg('u1', 'user', 100), msg('u2', 'user', 200)]; // lost a1 in the middle
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('is the inbound array untouched (fast path) for a full-transcript POST', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    expect(mergeChatMessages(existing, inbound)).toBe(inbound);
  });

  it('new file (no stored messages): returns inbound', () => {
    const inbound = [msg('u1', 'user', 100)];
    expect(mergeChatMessages([], inbound)).toBe(inbound);
  });

  it('inbound wins for a matching id (update-by-id — e.g. a pin toggle)', () => {
    const existing = [msg('u1', 'user', 100, { pinned: false }), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100, { pinned: true }), msg('a1', 'assistant', 101)];
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.find((m) => m.id === 'u1')?.pinned).toBe(true);
  });

  it('preserves server-authored turn attribution omitted by an older client', () => {
    const existing = [msg('a1', 'assistant', 101, {
      backend: 'codex',
      model: 'gpt-5.6',
      persistedVersion: 3,
    })];
    const inbound = [msg('a1', 'assistant', 101, { content: 'Complete response.' })];

    expect(mergeChatMessages(existing, inbound)).toEqual([expect.objectContaining({
      backend: 'codex',
      model: 'gpt-5.6',
      persistedVersion: 3,
    })]);
  });

  it('preserves a stored turn receipt omitted by an older client', () => {
    const receipt = {
      leadModel: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'fusion',
      pickedMode: 'solo',
    };
    const existing = [msg('a1', 'assistant', 101, { receipt })];
    const inbound = [msg('a1', 'assistant', 101, { content: 'Complete response.' })];

    expect(mergeChatMessages(existing, inbound)).toEqual([
      expect.objectContaining({ receipt }),
    ]);
  });

  it('preserves server-saved image paths when the client reposts the text bubble', () => {
    const media = [{ kind: 'image', path: '/private/media/photo.png', name: 'photo.png' }];
    const existing = [msg('u1', 'user', 101, { media })];
    const inbound = [msg('u1', 'user', 101)];
    expect(mergeChatMessages(existing, inbound)).toEqual([expect.objectContaining({ media })]);
  });

  it('preserves stored worker rows when a stale client reposts the base receipt', () => {
    const worker = { packetId: 'packet-1', runtime: 'codex', model: 'gpt-5.6-terra' };
    const receipt = { leadModel: 'gpt-6-astra', effort: 'high', mode: 'multitask' };
    const existing = [msg('a1', 'assistant', 101, { receipt: { ...receipt, workers: [worker] } })];
    const inbound = [msg('a1', 'assistant', 101, { receipt })];

    expect(mergeChatMessages(existing, inbound)).toEqual([
      expect.objectContaining({ receipt: { ...receipt, workers: [worker] } }),
    ]);
  });

  it('allows an explicitly attributed inbound turn to replace prior attribution', () => {
    const existing = [msg('a1', 'assistant', 101, { backend: 'codex', model: 'gpt-5.6' })];
    const inbound = [msg('a1', 'assistant', 101, { backend: 'claude', model: 'claude-opus-5' })];

    expect(mergeChatMessages(existing, inbound)).toBe(inbound);
  });

  it('keeps a stored message that lacks an id (defensive)', () => {
    const existing = [msg('u1', 'user', 100), { role: 'assistant', timestamp: 101, content: 'no-id' }];
    const inbound = [msg('u1', 'user', 100)];
    expect(mergeChatMessages(existing, inbound).length).toBe(2);
  });

  it('pins a re-stamped message back to its original time (mobile Date.now() bug)', () => {
    // Mobile re-POSTs the user messages stamped "now" (300) — far later than
    // their real creation times — as a partial (assistant replies omitted).
    const existing = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 110),
      msg('u2', 'user', 200),
      msg('a2', 'assistant', 210),
    ];
    const inbound = [msg('u1', 'user', 300), msg('u2', 'user', 300)];
    const merged = mergeChatMessages(existing, inbound);
    // Order stays chronological by ORIGINAL creation time — replies must NOT
    // float above the questions they answer.
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // And the persisted timestamp is pinned back to the original, not "now".
    expect(merged.find((m) => m.id === 'u1')?.timestamp).toBe(100);
    expect(merged.find((m) => m.id === 'u2')?.timestamp).toBe(200);
  });

  it('pins re-stamped timestamps even on a full-transcript POST (no preserved)', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 110)];
    // Full transcript, but the client re-stamped the user msg to "now" (300)
    // and emitted it last — the merge must re-sort it to its real slot.
    const inbound = [msg('a1', 'assistant', 110), msg('u1', 'user', 300)];
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged.find((m) => m.id === 'u1')?.timestamp).toBe(100);
  });

  it('collapses adjacent same-role identical-content duplicates with different ids', () => {
    const existing = [msg('u1', 'user', 100), msg('assistant-1', 'assistant', 110, { content: 'same' })];
    const inbound = [msg('orch-assistant-1', 'assistant', 111, { content: 'same' })];
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'assistant-1']);
  });

  it('keeps distinct images sent with the same caption in adjacent turns', () => {
    const first = msg('u1', 'user', 100, {
      content: 'look at this', media: [{ kind: 'image', path: '/private/media/first.png' }],
    });
    const second = msg('u2', 'user', 200, {
      content: 'look at this', media: [{ kind: 'image', path: '/private/media/second.png' }],
    });
    expect(mergeChatMessages([first], [first, second]).map((message) => message.id)).toEqual(['u1', 'u2']);
    expect(mergeChatMessages([first], [second]).map((message) => message.id)).toEqual(['u1', 'u2']);
  });
});

describe('confirmed orchestrator delivery warnings', () => {
  const user = msg('orch-user-send-1', 'user', 100, { deliveryConfirmed: true });
  const warning = msg('orch-delivery-error-send-1', 'system', 104);

  it('does not let an explicit stale false confirmation revive the warning', () => {
    const staleUser = { ...user, deliveryConfirmed: false };
    const merged = mergeChatMessages([user], [staleUser, warning]);
    expect(merged).toEqual([user]);
  });

  it('requires a confirmed matching user and only removes system warnings', () => {
    const unrelated = msg('orch-delivery-error-other', 'system', 105);
    const wrongRole = { ...warning, id: warning.id, role: 'assistant' };
    expect(mergeChatMessages([user], [wrongRole, unrelated]).map((entry) => entry.id))
      .toEqual([user.id, warning.id, unrelated.id]);
    expect(mergeChatMessages([{ ...user, id: user.id, role: 'assistant' }], [warning])).toContainEqual(warning);
  });

  it('does not infer delivery from an ordinary assistant reply or similar identifier', () => {
    const reply = msg('reply', 'assistant', 106);
    const otherUser = { ...user, id: 'orch-user-send-10' };
    expect(mergeChatMessages([warning], [reply, otherUser])).toContainEqual(warning);
  });
});
