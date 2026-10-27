import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTerminalActivityTracker } from './terminal-activity';
import type { TerminalTab } from './types';

function terminalTab(id: string, session: string, lastActivity = 100): TerminalTab {
  return { id, label: id, kind: 'terminal', tmuxSession: session, createdAt: 100, lastActivity };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTerminalActivityTracker', () => {
  it('keeps PTY activity outside React state and commits the newest timestamp once per window', () => {
    vi.useFakeTimers();
    let tabs = [terminalTab('tab-1', 'session-1')];
    let commits = 0;
    const getTabs = vi.fn(() => tabs);
    const tracker = createTerminalActivityTracker({
      getTabs,
      setTabs: (update) => {
        commits += 1;
        tabs = typeof update === 'function' ? update(tabs) : update;
      },
    });

    expect(getTabs).not.toHaveBeenCalled();
    tracker.record('session-1', 200);
    tracker.record('session-1', 300);
    expect(commits).toBe(0);
    expect(tracker.merge(tabs)[0]?.lastActivity).toBe(300);

    vi.advanceTimersByTime(999);
    expect(commits).toBe(0);
    vi.advanceTimersByTime(1);
    expect(commits).toBe(1);
    expect(tabs[0]?.lastActivity).toBe(300);
    tracker.dispose();
  });

  it('throttles tabs independently and ignores unknown sessions', () => {
    vi.useFakeTimers();
    let tabs = [terminalTab('tab-1', 'session-1'), terminalTab('tab-2', 'session-2')];
    let commits = 0;
    const tracker = createTerminalActivityTracker({
      getTabs: () => tabs,
      setTabs: (update) => {
        commits += 1;
        tabs = typeof update === 'function' ? update(tabs) : update;
      },
    });

    tracker.record('missing', 500);
    tracker.record('session-1', 600);
    tracker.record('session-2', 700);
    vi.runAllTimers();

    expect(commits).toBe(2);
    expect(tabs.map((tab) => tab.lastActivity)).toEqual([600, 700]);
    tracker.dispose();
  });
});
