import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { redactOutputText } from './output-redaction';

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
