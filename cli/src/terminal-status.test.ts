import { describe, expect, it } from 'vitest';

import {
  createTerminalStatusReporter,
  encodeTerminalStatus,
  packetStatusReport,
  sanitizeStatusText,
  terminalStatusEnabled,
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
    expect(text(pairs.title)).toBe('Fix login');
    expect(text(pairs.msg)).toBe('Waiting for review');
    for (const value of Object.values(pairs)) expect(value).toMatch(/^[A-Za-z0-9_.,+/=-]*$/);
  });

  it('strips control and direction-override characters before encoding', () => {
    const pairs = decodePairs(encodeTerminalStatus({
      state: 'done',
      title: 'a\x1b]0;evil\x07b\nc\td‮e\u0085f',
    }));
    const title = text(pairs.title);
    expect(title).toBe('a ]0;evil b c d e f');
    expect(title).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
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
    expect(encodeTerminalStatus({ state: 'working', title: ' \n ', msg: null })).toBe('\x1b]7501;state=working:app=o8\x1b\\');
    expect(encodeTerminalStatus({ state: 'clear', title: 'ignored' })).toBe('\x1b]7501;state=clear\x1b\\');
  });

  it('sanitizeStatusText collapses whitespace', () => {
    expect(sanitizeStatusText('  a \r\n  b  ', 100)).toBe('a b');
  });
});

describe('terminalStatusEnabled', () => {
  const rex = { REX_SESSION: 'session:abc' };

  it('is on for human output in a Rex terminal', () => {
    expect(terminalStatusEnabled(human, rex, stream(true))).toBe(true);
  });

  it('is off without Rex, for JSON output, and when stdout is not a terminal', () => {
    expect(terminalStatusEnabled(human, {}, stream(true))).toBe(false);
    expect(terminalStatusEnabled(json, rex, stream(true))).toBe(false);
    expect(terminalStatusEnabled(human, rex, stream(false))).toBe(false);
  });

  it('O8_TERMINAL_STATUS=0 turns it off and =1 forces it on in a terminal', () => {
    expect(terminalStatusEnabled(human, { ...rex, O8_TERMINAL_STATUS: '0' }, stream(true))).toBe(false);
    expect(terminalStatusEnabled(json, { O8_TERMINAL_STATUS: '1' }, stream(true))).toBe(true);
    expect(terminalStatusEnabled(human, { O8_TERMINAL_STATUS: '1' }, stream(false))).toBe(false);
  });
});

describe('createTerminalStatusReporter', () => {
  it('writes nothing when disabled', () => {
    const out = stream(true);
    createTerminalStatusReporter(json, { REX_SESSION: 's' }, out).report({ state: 'working' });
    expect(out.writes).toEqual([]);
  });

  it('writes each distinct report once', () => {
    const out = stream(true);
    const reporter = createTerminalStatusReporter(human, { REX_SESSION: 's' }, out);
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
