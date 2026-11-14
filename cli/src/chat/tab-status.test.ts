import { describe, expect, it } from 'vitest';

import { encodeTerminalStatus } from '../terminal-status';
import { chatStatusReport, initialTurnTracker, trackTurn, type ChatTabState, type TurnSignal } from './tab-status';

const base: ChatTabState = { connection: 'connected', busy: false, error: false, replyReady: false };

describe('chatStatusReport', () => {
  it('maps each chat state to one fixed phrase', () => {
    expect(chatStatusReport(base)).toEqual({ state: 'idle', msg: 'Ready' });
    expect(chatStatusReport({ ...base, connection: 'connecting' })).toEqual({ state: 'working', msg: 'Connecting' });
    expect(chatStatusReport({ ...base, busy: true })).toEqual({ state: 'working', msg: 'Working' });
    expect(chatStatusReport({ ...base, replyReady: true })).toEqual({ state: 'done', msg: 'Reply ready' });
    expect(chatStatusReport({ ...base, error: true })).toEqual({ state: 'error', msg: 'Needs attention' });
    expect(chatStatusReport({ ...base, connection: 'disconnected' })).toEqual({ state: 'error', msg: 'Connection lost' });
  });

  it('puts a lost connection and an error ahead of everything else', () => {
    expect(chatStatusReport({ connection: 'disconnected', busy: true, error: true, replyReady: true }).msg).toBe('Connection lost');
    expect(chatStatusReport({ connection: 'connecting', busy: true, error: true, replyReady: true }).msg).toBe('Needs attention');
    expect(chatStatusReport({ ...base, busy: true, replyReady: true }).msg).toBe('Working');
  });

  it('encodes every report on o8 own record with the idle state the protocol defines', () => {
    expect(encodeTerminalStatus(chatStatusReport(base))).toBe('\x1b]7501;state=idle:id=o8:app=o8:msg=UmVhZHk=\x1b\\');
  });
});

describe('trackTurn', () => {
  const after = (...signals: TurnSignal[]) => signals.reduce(trackTurn, initialTurnTracker);

  it('marks a reply ready only after a turn it saw start finishes cleanly', () => {
    expect(after().replyReady).toBe(false);
    expect(after('ready').replyReady).toBe(false);
    expect(after('started').replyReady).toBe(false);
    expect(after('started', 'ready')).toEqual({ running: false, stopRequested: false, replyReady: true });
    // The mark holds until the next message is sent.
    expect(after('started', 'ready', 'ready').replyReady).toBe(true);
    expect(after('started', 'ready', 'started').replyReady).toBe(false);
  });

  it('does not claim a reply for a turn the operator stopped', () => {
    expect(after('started', 'stop-requested', 'ready').replyReady).toBe(false);
    expect(after('stop-requested', 'started', 'ready').replyReady).toBe(true);
  });

  it('does not claim a reply for a failed turn, even after a reconnect', () => {
    expect(after('started', 'failed').replyReady).toBe(false);
    expect(after('started', 'failed', 'reset', 'ready').replyReady).toBe(false);
    // A failure also withdraws an earlier reply mark: the tab now needs attention.
    expect(after('started', 'ready', 'failed').replyReady).toBe(false);
  });

  it('drops a running turn on a reconnect but keeps a reply that already arrived', () => {
    expect(after('started', 'reset', 'ready').replyReady).toBe(false);
    expect(after('started', 'ready', 'reset').replyReady).toBe(true);
  });

  it('ignores replayed events when a conversation is opened: nothing was sent from this chat', () => {
    // Opening a conversation replays its tail, which can hold a finished turn.
    expect(after('reset', 'ready').replyReady).toBe(false);
    expect(after('reset', 'failed', 'ready').replyReady).toBe(false);
    // A turn sent after the connection opened still counts.
    expect(after('reset', 'ready', 'started', 'ready').replyReady).toBe(true);
  });

  it('treats a repeated busy report as the same turn', () => {
    expect(after('started', 'stop-requested', 'started', 'ready').replyReady).toBe(false);
  });
});
