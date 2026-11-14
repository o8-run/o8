import { describe, expect, it } from 'vitest';

import {
  createTerminalStatusReporter,
  encodeTerminalStatus,
  missionTailReport,
  packetRecordSegment,
  packetStatusReport,
  packetTailReport,
  statusRecordId,
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

describe('per-packet records', () => {
  it('addresses a child record under o8 with a valid id segment', () => {
    expect(statusRecordId()).toBe('o8');
    expect(statusRecordId('pkt-1')).toBe('o8/pkt-1');
    const pairs = decodePairs(encodeTerminalStatus({ state: 'working', packetId: 'pkt-1', title: 'One' }));
    expect(pairs.id).toBe('o8/pkt-1');
    expect(encodeTerminalStatus({ state: 'clear', packetId: 'pkt-1' })).toBe('\x1b]7501;state=clear:id=o8/pkt-1\x1b\\');
  });

  it('gives different packet ids different records, whatever their shape', () => {
    const ids = [
      'a/b', 'a:b', 'a b', 'a_b',
      'pkt-0b9d2f6e-6a57-4c58-9a0e-3f1f2c4d5e6f',
      'pkt-1b9d2f6e-6a57-4c58-9a0e-3f1f2c4d5e6f',
      `x-${'a'.repeat(40)}-same-tail`,
      `y-${'a'.repeat(40)}-same-tail`,
    ];
    const segments = ids.map((id) => packetRecordSegment(id));
    expect(new Set(segments).size).toBe(ids.length);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_.+-]{1,32}$/);
    expect(packetRecordSegment('a_b')).toBe('a_b');
  });

  it('never lets a packet without an id address o8 own record', () => {
    expect(packetRecordSegment('')).toBe('');
    expect(packetRecordSegment('   ')).toBe('');
    expect(packetTailReport({ id: '', status: 'running', title: 'T' })).toBeNull();
  });

  it('maps every packet status to a fixed phrase', () => {
    expect(packetTailReport({ id: 'p', status: 'running', title: 'T' })).toEqual({ state: 'working', packetId: 'p', title: 'T', msg: 'Running' });
    expect(packetTailReport({ id: 'p', status: 'something_new', title: 'T' })?.msg).toBe('In progress');
    expect(packetTailReport({ id: 'p', status: 'blocked', title: 'T' })).toEqual({ state: 'error', packetId: 'p', title: 'T', msg: 'Blocked: needs a decision' });
  });

  it('summarizes the mission on its own record', () => {
    expect(missionTailReport([{ status: 'running' }, { status: 'released' }])).toEqual({ state: 'working', title: '2 packets', msg: '1 of 2 finished' });
    expect(missionTailReport([{ status: 'awaiting_review' }, { status: 'released' }]).state).toBe('done');
    expect(missionTailReport([{ status: 'failed' }, { status: 'released' }])).toEqual({ state: 'error', title: '2 packets', msg: '1 of 2 failed, blocked, or archived' });
    expect(missionTailReport([]).state).toBe('working');
  });

  it('skips repeats per record and forgets children after clearing o8', () => {
    const out = stream(true);
    const reporter = createTerminalStatusReporter(human, { REX_SESSION: 's' }, out, stream(true));
    reporter.report({ state: 'working', packetId: 'a', title: 'A' });
    reporter.report({ state: 'working', packetId: 'b', title: 'B' });
    reporter.report({ state: 'working', packetId: 'a', title: 'A' });
    expect(out.writes).toHaveLength(2);
    reporter.report({ state: 'clear' });
    reporter.report({ state: 'working', packetId: 'a', title: 'A' });
    expect(out.writes).toHaveLength(4);
  });

  it('always writes a clear, even right after another clear', () => {
    const out = stream(true);
    const reporter = createTerminalStatusReporter(human, { REX_SESSION: 's' }, out, stream(true));
    reporter.report({ state: 'clear' });
    reporter.report({ state: 'working', packetId: 'a', title: 'A' });
    reporter.report({ state: 'clear' });
    reporter.report({ state: 'clear', packetId: 'a' });
    reporter.report({ state: 'working', packetId: 'a', title: 'A' });
    expect(out.writes).toHaveLength(5);
  });
});
