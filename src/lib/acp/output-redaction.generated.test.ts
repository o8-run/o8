import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createAcpOutputRedactor } from './output-redaction';

const { recipes, encode } = createRequire(import.meta.url)('../../../tests/fixtures/acp-encoding-cases.cjs') as {
  recipes: Array<{ name: string; steps: string[] }>; encode(value: string, steps: string[]): string;
};
const canary = 'synthetic-normalization:"quote"\\\n café/<> &?+=😀';
it.each(recipes)('normalizes generated %s without releasing a recoverable saved value', recipe => {
  const encoded = encode(canary, recipe.steps);
  const redactor = createAcpOutputRedactor([canary]);
  const result = redactor.redact(`Before ${encoded} after.`);
  expect(result.includes(encoded), recipe.name).toBe(false);
  expect(result.includes(canary), recipe.name).toBe(false);
  expect(result).toContain('[redacted]');
});

it('matches an arbitrary unicode escape at every saved-secret code unit', () => {
  const redactor = createAcpOutputRedactor([canary]);
  for (let offset = 0; offset < canary.length; offset++) {
    const encoded = canary.split('').map((char, index) => index === offset
      ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : JSON.stringify(char).slice(1, -1)).join('');
    expect(redactor.redact(`Before ${encoded} after.`), `code unit ${offset}`).toBe('Before [redacted] after.');
  }
});

it.each(['/', 'prefix/', 'prefix-', 'prefix', 'prefix '])('refuses ambiguous nested Base64 behind %s', prefix => {
  const secret = 'secret!';
  const encoded = Buffer.from(encode(secret, ['percent'])).toString('base64');
  const result = createAcpOutputRedactor([secret]).redact(prefix + encoded);
  expect(result.includes(encoded)).toBe(false);
  expect(result).toContain('[redacted]');
});

it('does not expose a nested Base64 prefix at an intermediate stream boundary', () => {
  const secret = 'secret!';
  const encoded = Buffer.from(Buffer.from(secret).toString('base64')).toString('base64');
  const chunks: string[] = [];
  const stream = createAcpOutputRedactor([secret]).stream(chunk => chunks.push(chunk));
  stream(encoded.slice(0, 1), true, true);
  expect(chunks.join('')).toBe('[redacted]');
  stream(encoded.slice(1), true);
  expect(chunks.join('').includes(encoded)).toBe(false);
});

it('does not discard a genuine replacement character inside an ambiguously wrapped credential', () => {
  const secret = 'abc\uFFFD"def';
  const encoded = Buffer.from(JSON.stringify(secret).slice(1, -1)).toString('base64');
  const result = createAcpOutputRedactor([secret]).redact('prefix' + encoded);
  expect(result).toBe('[redacted]');
});

it('fails closed for malformed escapes and normalization or streaming budget exhaustion', () => {
  const redactor = createAcpOutputRedactor([canary]);
  for (const value of [`broken %GG ${encode(canary, ['percent'])}`, `broken \\u0ZZZ ${encode(canary, ['json'])}`]) {
    expect(redactor.redact(value)).toBe('[redacted]');
  }
  let nested = encode(canary, ['percent']);
  for (let index = 0; index < 20; index++) nested = encodeURIComponent(nested);
  expect(redactor.redact(nested)).toBe('[redacted]');
  const oversized = 'x'.repeat(256 * 1024 + 1);
  expect(redactor.redact(oversized + canary)).toBe('[redacted]');
  const chunks: string[] = []; const write = redactor.stream(chunk => chunks.push(chunk));
  write(oversized); write(canary); write('', true);
  expect(chunks).toEqual(['[redacted]']);
});

it('retains original spans for unambiguous encodings and streams unchanged without saved secrets', () => {
  const simple = 'synthetic-span-secret';
  const redactor = createAcpOutputRedactor([simple]);
  for (const steps of [['json'], ['percent'], ['base64'], ['base64url']]) {
    expect(redactor.redact(`Before ${encode(simple, steps)} after.`)).toBe('Before [redacted] after.');
  }
  let output = ''; const write = createAcpOutputRedactor([]).stream(chunk => { output += chunk; });
  write('Immediate'); expect(output).toBe('Immediate');
  write(' output', true); expect(output).toBe('Immediate output');
});
