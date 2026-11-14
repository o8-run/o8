import { describe, expect, it } from 'vitest';

import {
  createTerminalStatusReporter,
  encodeTerminalStatus,
  packetStatusReport,
  sanitizeStatusText,
  terminalStatusStream,
  watchingStatusReport,
} from './terminal-status';

const human = { human: true, verbose: false };
const json = { human: false, verbose: false };

function stream(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, writes, write: (chunk: string) => writes.push(chunk) };
}

function decodePairs(sequence: string): Record<string, string> {
  expect(sequence.startsWith('\x1b]7501;')).toBe(true);
  expect(sequence.endsWith('\x1b\\')).toBe(true);
  const body = sequence.slice('\x1b]7501;'.length, -2);
  return Object.fromEntries(body.split(':').map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
}

function text(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

describe('encodeTerminalStatus', () => {
  it('encodes state, app, and base64 title and message', () => {
    const pairs = decodePairs(encodeTerminalStatus({ state: 'working', title: 'Fix login', msg: 'Waiting for review' }));
    expect(pairs.state).toBe('working');
    expect(pairs.app).toBe('o8');
    expect(pairs.id).toBe('o8');
    expect(text(pairs.title)).toBe('Fix login');
    expect(text(pairs.msg)).toBe('Waiting for review');
    for (const value of Object.values(pairs)) expect(value).toMatch(/^[A-Za-z0-9_.,+/=-]*$/);
  });

  it('strips control, direction-override, and zero-width characters before encoding', () => {
    const pairs = decodePairs(encodeTerminalStatus({
      state: 'done',
      title: 'a\x1b]0;evil\x07b\nc\td\u202ee\u0085f\u200bg\u2060h\ufeffi',
    }));
    const title = text(pairs.title);
    expect(title).toBe('a ]0;evil b c d e f g h i');
    expect(title).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
  });

  it('keeps an oversized title and message inside the protocol limits', () => {
    const sequence = encodeTerminalStatus({
      state: 'error',
      title: 'é'.repeat(5000),
      msg: '字'.repeat(5000),
    });
    const pairs = decodePairs(sequence);
    expect(Buffer.byteLength(sequence, 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(text(pairs.title), 'utf8')).toBeLessThanOrEqual(192);
    expect(pairs.title.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(text(pairs.msg), 'utf8')).toBeLessThanOrEqual(2048);
    expect(pairs.msg.length).toBeLessThanOrEqual(2732);
    // Truncation lands on a character boundary.
    expect(text(pairs.title)).toBe('é'.repeat(96));
    expect(text(pairs.msg)).not.toContain('�');
  });

  it('omits empty text and encodes clear with no other keys', () => {
    expect(encodeTerminalStatus({ state: 'working', title: ' \n ', msg: null })).toBe('\x1b]7501;state=working:id=o8:app=o8\x1b\\');
    expect(encodeTerminalStatus({ state: 'clear', title: 'ignored' })).toBe('\x1b]7501;state=clear:id=o8\x1b\\');
  });

  it('sanitizeStatusText collapses whitespace', () => {
    expect(sanitizeStatusText('  a \r\n  b  ', 100)).toBe('a b');
  });
});

describe('terminalStatusStream', () => {
  const rex = { REX_SESSION: 'session:abc' };

  it('writes human output to stdout in a Rex terminal', () => {
    const out = stream(true);
    expect(terminalStatusStream(human, rex, out, stream(true))).toBe(out);
  });

  it('is off without Rex, for JSON output, and when stdout is not a terminal', () => {
    expect(terminalStatusStream(human, {}, stream(true), stream(true))).toBeNull();
    expect(terminalStatusStream(json, rex, stream(true), stream(true))).toBeNull();
    expect(terminalStatusStream(human, rex, stream(false), stream(true))).toBeNull();
  });

  it('O8_TERMINAL_STATUS=0 turns it off and =1 forces human output without Rex', () => {
    const out = stream(true);
    expect(terminalStatusStream(human, { ...rex, O8_TERMINAL_STATUS: '0' }, stream(true), stream(true))).toBeNull();
    expect(terminalStatusStream(human, { O8_TERMINAL_STATUS: '1' }, out, stream(true))).toBe(out);
    expect(terminalStatusStream(human, { O8_TERMINAL_STATUS: '1' }, stream(false), stream(true))).toBeNull();
  });

  it('forced JSON output goes to stderr, never stdout, and only to a terminal', () => {
    const err = stream(true);
    expect(terminalStatusStream(json, { O8_TERMINAL_STATUS: '1' }, stream(true), err)).toBe(err);
    expect(terminalStatusStream(json, { O8_TERMINAL_STATUS: '1' }, stream(true), stream(false))).toBeNull();
  });
});

describe('createTerminalStatusReporter', () => {
  it('writes nothing when disabled', () => {
    const out = stream(true);
    createTerminalStatusReporter(json, { REX_SESSION: 's' }, out, stream(true)).report({ state: 'working' });
    expect(out.writes).toEqual([]);
  });

  it('writes each distinct report once', () => {
    const out = stream(true);
    const reporter = createTerminalStatusReporter(human, { REX_SESSION: 's' }, out, stream(true));
    reporter.report({ state: 'working', title: 'A' });
    reporter.report({ state: 'working', title: 'A' });
    reporter.report({ state: 'done', title: 'A' });
    expect(out.writes).toHaveLength(2);
  });
});

describe('packet reports', () => {
  it('maps review and release to done, and failure states to error', () => {
    expect(packetStatusReport('awaiting_review', 'T')).toEqual({ state: 'done', title: 'T', msg: 'Awaiting review' });
    expect(packetStatusReport('released', 'T')?.state).toBe('done');
    expect(packetStatusReport('failed', 'T')?.state).toBe('error');
    expect(packetStatusReport('blocked', 'T')?.state).toBe('error');
    expect(packetStatusReport('archived', 'T')?.state).toBe('error');
    expect(packetStatusReport('running', 'T')).toBeNull();
    expect(packetStatusReport(null, 'T')).toBeNull();
  });

  it('labels the watcher with the packet title, or a count for several', () => {
    expect(watchingStatusReport([{ title: 'One' }])).toEqual({ state: 'working', title: 'One', msg: 'Waiting for review' });
    expect(watchingStatusReport([{ title: 'One' }, { title: 'Two' }]).title).toBe('2 packets');
    expect(watchingStatusReport([]).title).toBeNull();
  });
});
