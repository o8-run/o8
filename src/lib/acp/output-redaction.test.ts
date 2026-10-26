import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactOutputText, createAcpOutputRedactor } from './output-redaction';

describe('viewer output redaction bounds and byte contract', () => {
  it('preserves benign non-ASCII text and option-like paths', () => {
    const text = 'π 🔒 src/-utils.ts --unified=3';
    expect(redactOutputText(text)).toEqual({ text, spans: [] });
  });
  it('bounds scanning of long benign identifiers', () => {
    const text = 'a'.repeat(20_000);
    const start = performance.now();
    expect(redactOutputText(text)).toEqual({ text, spans: [] });
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('preserves escaped delimiter semantics across lines', () => {
    const result = redactOutputText(String.raw`pass\u0077ord="fixture\"line` + '\nmultiline-tail"');
    expect(result.text).not.toContain('multiline-tail');
    for (const span of result.spans) expect(Buffer.from(result.text).subarray(span.start, span.end).toString()).toBe('[redacted]');
  });
});


it('redacts maximum-length saved credentials without overflowing the matcher, including split encoded output', () => {
  const secret = Array.from({ length: 128 }, (_, index) => createHash('sha256').update(`synthetic-long-canary:${index}`).digest('hex')).join('');
  expect(secret).toHaveLength(8192);
  let failed = false;
  let outputs: string[] = [];
  try {
    const redactor = createAcpOutputRedactor([secret]);
    const forms = [secret, Buffer.from(secret).toString('base64'), secret.split('').map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
    outputs = forms.map(value => redactor.redact(`Before ${value} after.`));
    let streamed = '';
    const write = redactor.stream(value => { streamed += value; });
    const encoded = forms[2];
    write('Before ' + encoded.slice(0, 10)); write(encoded.slice(10, -3)); write(encoded.slice(-3) + ' after.', true);
    outputs.push(streamed);
  } catch { failed = true; } // A regex error can contain its secret pattern; never print it.
  expect(failed).toBe(false);
  expect(outputs).toEqual(Array(4).fill('Before [redacted] after.'));
});

it('keeps JSON redaction available when a saved value has an unpaired surrogate', () => {
  const secret = 'synthetic-surrogate-\ud800-canary';
  const redactor = createAcpOutputRedactor([secret]);
  expect(redactor.redact(JSON.stringify({ token: secret }))).toBe('{"token":"[redacted]"}');
});
