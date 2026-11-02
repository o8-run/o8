import { describe, it, expect } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createAssistantTextBuffer } from './orchestrator-assistant-text';

/**
 * ws-server's `text` case appends into this buffer and its `turn_retry` case
 * discards it. The loop below mirrors that switch so the regression is asserted
 * on an event stream, which is the shape the bug actually took: attempt 1's
 * narration and attempt 2's narration concatenated into one persisted reply.
 */
function drain(events: OrchestratorEvent[]) {
  const buffer = createAssistantTextBuffer();
  for (const event of events) {
    if (event.type === 'text') buffer.append(event.text);
    else if (event.type === 'turn_retry') buffer.discard();
  }
  return buffer;
}

const retry: OrchestratorEvent = {
  type: 'turn_retry', attempt: 2, reason: 'false-dispatch', notice: 'retrying',
};

describe('createAssistantTextBuffer', () => {
  it('accumulates a normal turn', () => {
    const buffer = drain([
      { type: 'text', text: 'Launched ' },
      { type: 'text', text: 'three agents.' },
    ]);
    expect(buffer.value).toBe('Launched three agents.');
    expect(buffer.discarded).toBe(false);
  });

  it('does NOT glue a retried attempt onto the discarded one', () => {
    const buffer = drain([
      { type: 'text', text: 'I dispatched three agents. ' },
      { type: 'text', text: 'Send me a message when you want me to review.' },
      retry,
      { type: 'text', text: 'Launched lane-a, lane-b, lane-c.' },
    ]);
    expect(buffer.value).toBe('Launched lane-a, lane-b, lane-c.');
    expect(buffer.value).not.toContain('I dispatched three agents');
    expect(buffer.discarded).toBe(true);
  });

  it('persists the retried attempt even when the discarded one was already written', () => {
    // The 1.5s incremental persist means the discarded attempt is usually on
    // disk by the time the detector fires. `discard()` clears the
    // last-persisted marker too, otherwise a retry whose text happened to match
    // would be short-circuited as "unchanged" and the stale row would stand.
    const buffer = createAssistantTextBuffer();
    buffer.append('I dispatched three agents.');
    expect(buffer.shouldPersist(false)).toBe(true);
    buffer.markPersisted();
    expect(buffer.shouldPersist(false)).toBe(false);

    buffer.discard();
    buffer.append('I dispatched three agents.');
    expect(buffer.shouldPersist(false)).toBe(true);
  });

  it('never persists an empty buffer, but a receipt still forces a write of real text', () => {
    const buffer = createAssistantTextBuffer();
    expect(buffer.shouldPersist(true)).toBe(false);
    buffer.append('done');
    buffer.markPersisted();
    expect(buffer.shouldPersist(false)).toBe(false);
    expect(buffer.shouldPersist(true)).toBe(true);
  });

  it('a discard with no retry text leaves nothing to persist', () => {
    const buffer = drain([{ type: 'text', text: 'I dispatched three agents.' }, retry]);
    expect(buffer.value).toBe('');
    expect(buffer.shouldPersist(true)).toBe(false);
  });

  it('separates text blocks around a tool call and leaves stream deltas alone (#5209)', () => {
    const buffer = createAssistantTextBuffer();
    buffer.endBlock();
    expect(buffer.append('I will ')).toBe('I will ');
    expect(buffer.append('check.')).toBe('check.');
    buffer.endBlock();
    expect(buffer.append('The tree is clean.')).toBe('\n\nThe tree is clean.');
    expect(buffer.value).toBe('I will check.\n\nThe tree is clean.');
    buffer.endBlock();
    expect(buffer.append('\nDone.')).toBe('\nDone.');
  });
});
