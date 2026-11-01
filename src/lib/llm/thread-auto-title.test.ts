import { describe, expect, it } from 'vitest';
import { compactTitleFromMessage, decideAutoTitle } from './thread-auto-title';

describe('decideAutoTitle', () => {
  it('titles a fresh thread after the first exchange', () => {
    expect(decideAutoTitle({ title: undefined, messageCount: 2 })).toEqual({ run: true, reason: 'first' });
  });

  it('titles a thread created with a client placeholder title', () => {
    expect(decideAutoTitle({ title: 'New conversation', messageCount: 2 })).toEqual({ run: true, reason: 'first' });
    expect(decideAutoTitle({ title: 'Untitled conversation', messageCount: 2 }).run).toBe(true);
    // Mobile creates threads as "New chat".
    expect(decideAutoTitle({ title: 'New chat', messageCount: 2 }).run).toBe(true);
    // An operator who names a thread "New conversation" keeps it.
    expect(decideAutoTitle({ title: 'New conversation', titleSource: 'operator', messageCount: 2 }).run).toBe(false);
  });

  it('waits for a real exchange', () => {
    expect(decideAutoTitle({ title: undefined, messageCount: 1 }).run).toBe(false);
  });

  it('never touches an operator rename', () => {
    expect(decideAutoTitle({ title: 'My thread', titleSource: 'operator', messageCount: 20 }).run).toBe(false);
  });

  it('upgrades a legacy raw first-message crop (no titleSource, long)', () => {
    const legacy = 'The hygiene packet is awaiting review. Review the diff properly (all 6 files, +356/-7 — make sure you are looking at the committed branch diff';
    expect(decideAutoTitle({ title: legacy, messageCount: 4 })).toEqual({ run: true, reason: 'legacy-upgrade' });
  });

  it('leaves a short untagged title alone', () => {
    expect(decideAutoTitle({ title: 'Fix login bug', messageCount: 6 }).run).toBe(false);
  });

  it('refreshes an auto title once the thread develops', () => {
    expect(decideAutoTitle({ title: 'Early title', titleSource: 'llm', autoTitledAtCount: 2, messageCount: 9 }))
      .toEqual({ run: true, reason: 'refresh' });
  });

  it('refreshes only once', () => {
    expect(decideAutoTitle({ title: 'Later title', titleSource: 'llm', autoTitledAtCount: 9, messageCount: 14 }).run).toBe(false);
  });
});

describe('compactTitleFromMessage', () => {
  it('takes the first sentence and strips markdown noise', () => {
    expect(compactTitleFromMessage('**Fix** the `login` bug. Then do more stuff after that.')).toBe('Fix the login bug');
  });

  it('crops long text at a word boundary without trailing punctuation', () => {
    const title = compactTitleFromMessage('The hygiene packet is awaiting review and the diff needs a proper walk before merge');
    expect(title!.length).toBeLessThanOrEqual(48);
    expect(title!.endsWith(' ')).toBe(false);
    expect(/[.!?,;:]$/.test(title!)).toBe(false);
  });

  it('returns null for empty/noise-only input', () => {
    expect(compactTitleFromMessage('```\ncode only\n```')).toBeNull();
  });
});
