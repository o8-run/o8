import { describe, expect, it } from 'vitest';

import { encodeTerminalStatus } from '../terminal-status';
import { chatStatusReport, nextReplyReady, type ChatTabState } from './tab-status';

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

describe('nextReplyReady', () => {
  it('turns on when a turn ends and off when the next one starts', () => {
    const idle = { busy: false, replyReady: false };
    expect(nextReplyReady(idle, { busy: false, connection: 'connected' })).toBe(false);
    expect(nextReplyReady(idle, { busy: true, connection: 'connected' })).toBe(false);
    expect(nextReplyReady({ busy: true, replyReady: false }, { busy: false, connection: 'connected' })).toBe(true);
    expect(nextReplyReady({ busy: false, replyReady: true }, { busy: false, connection: 'connected' })).toBe(true);
    expect(nextReplyReady({ busy: false, replyReady: true }, { busy: true, connection: 'connected' })).toBe(false);
  });

  it('does not treat a reconnect that resets the turn as a finished reply', () => {
    expect(nextReplyReady({ busy: true, replyReady: false }, { busy: false, connection: 'connecting' })).toBe(false);
    expect(nextReplyReady({ busy: true, replyReady: false }, { busy: false, connection: 'disconnected' })).toBe(false);
    expect(nextReplyReady({ busy: false, replyReady: true }, { busy: false, connection: 'connecting' })).toBe(true);
  });
});
