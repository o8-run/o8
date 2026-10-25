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
  expect(chunks.join('')).toBe('');
  stream(encoded.slice(1), true);
  expect(chunks.join('')).toBe('[redacted]');
});

it('does not discard a genuine replacement character inside an ambiguously wrapped credential', () => {
  const secret = 'abc\uFFFD"def';
  const encoded = Buffer.from(JSON.stringify(secret).slice(1, -1)).toString('base64');
  const result = createAcpOutputRedactor([secret]).redact('prefix' + encoded);
  expect(result).toBe('prefix[redacted]');
});

it('redacts actual matches while preserving malformed syntax and large benign output', () => {
  const redactor = createAcpOutputRedactor([canary]);
  for (const value of [`broken %GG ${encode(canary, ['percent'])}`, `broken \\u0ZZZ ${encode(canary, ['json'])}`]) {
    expect(redactor.redact(value)).toBe(value.startsWith('broken %') ? 'broken %GG [redacted]' : 'broken \\u0ZZZ [redacted]');
  }
  let nested = encode(canary, ['percent']);
  for (let index = 0; index < 20; index++) nested = encodeURIComponent(nested);
  expect(redactor.redact(nested)).toBe('[redacted]');
  const oversized = 'x'.repeat(256 * 1024 + 1);
  expect(redactor.redact(oversized + canary)).toBe(oversized + '[redacted]');
  const chunks: string[] = []; const write = redactor.stream(chunk => chunks.push(chunk));
  write(oversized); write(canary); write('', true);
  expect(chunks).toEqual([oversized + '[redacted]']);
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

it('preserves invalid UTF-8 beside valid percent and base64 matches and unrelated padding text', () => {
  const redactor = createAcpOutputRedactor(['abc']);
  expect(redactor.redact('%FF%61%62%63')).toBe('%FF[redacted]');
  expect(redactor.redact('YWJj !!! = ???')).toBe('[redacted] !!! = ???');
  expect(createAcpOutputRedactor(['a\uFFFDb']).redact(Buffer.from([97, 255, 98]).toString('base64'))).toBe('Yf9i');
});

it('collapses long escape prefix chains without skipping saved literal escape syntax', () => {
  const redactor = createAcpOutputRedactor(['abc']);
  const percent = '%' + '25'.repeat(500_000) + '61bc';
  const json = '\\' + 'u005C'.repeat(200_000) + 'u0061bc';
  const start = performance.now();
  expect(redactor.redact(percent)).toBe('[redacted]');
  expect(redactor.redact(json)).toBe('[redacted]');
  expect(performance.now() - start).toBeLessThan(4000);
  for (const secret of ['abc%25def', 'abc%ab', 'abc\\u005Cdef', 'abc\\u0061']) {
    const wrapped = secret.replace(/%/g, '%252525').replace(/\\/g, '\\u005cu005C');
    expect(createAcpOutputRedactor([secret]).redact(wrapped)).toBe('[redacted]');
  }
  expect(createAcpOutputRedactor(['\\u005C']).redact('\\u005c')).toBe('\\u005c');
});

it('maps repeated base64 matches once in 4 MiB output', () => {
  const secret = 'synthetic-repeated-credential';
  const encoded = Buffer.from(secret).toString('base64');
  const count = Math.floor(4 * 1024 * 1024 / (encoded.length + 2));
  const value = (encoded + '!\n').repeat(count);
  const start = performance.now();
  const output = createAcpOutputRedactor([secret]).redact(value);
  expect(output === '[redacted]!\n'.repeat(count)).toBe(true);
  console.log(`ACP_4MIB_REPEATED_MS=${(performance.now() - start).toFixed(2)}`);
  expect(performance.now() - start).toBeLessThan(4000);
});

it('uses the outer byte phase for padding and compacts invalid bytes only for nested base64', () => {
  expect(createAcpOutputRedactor(['ab']).redact('eGFi = ???')).toBe('e[redacted] = ???');
  expect(createAcpOutputRedactor(['a']).redact('eGE=')).toBe('e[hidden]');
  const nested = Buffer.from([89, 255, 87, 255, 74, 255, 106]).toString('base64');
  expect(createAcpOutputRedactor(['abc']).redact(nested)).toBe('[redacted]');
});

it('collapses mixed prefix chains while preserving literal syntax at intermediate layers', () => {
  const chain = '%' + '5Cu0025'.repeat(100_000);
  const start = performance.now();
  expect(createAcpOutputRedactor(['abc']).redact(chain + '61bc')).toBe('[redacted]');
  expect(createAcpOutputRedactor(['%25ab']).redact(chain + '25ab')).toBe('[redacted]');
  expect(performance.now() - start).toBeLessThan(4000);
});

it('retains different literal escape depths locally and bounds benign mixed chains', () => {
  expect(createAcpOutputRedactor(['a%61']).redact('%2561%2561')).toBe('[redacted]');
  const chain = '%' + '5Cu0025'.repeat(50_000);
  const value = chain + '25a%62%63';
  expect(createAcpOutputRedactor(['%25abc']).redact(value)).toBe('[redacted]');
  const benign = chain + '61bd';
  const start = performance.now();
  expect(createAcpOutputRedactor(['abc']).redact(benign) === benign).toBe(true);
  expect(performance.now() - start).toBeLessThan(4000);
});

it('memoizes failed local spelling choices instead of exploring equivalent paths', () => {
  const secret = '%'.repeat(64) + 'X';
  const value = '%25'.repeat(64) + 'Y';
  const start = performance.now();
  expect(createAcpOutputRedactor([secret]).redact(value)).toBe(value);
  expect(performance.now() - start).toBeLessThan(1000);
});

it('matches a saved literal depth beside a JSON-wrapped UTF-8 continuation marker', () => {
  expect(createAcpOutputRedactor(['%2561é']).redact('%252561%C3\\u005Cu0025A9')).toBe('[redacted]');
});

it('keeps normalization exploration modes separate in match-free caches', () => {
  const output = createAcpOutputRedactor(['abc', 'STOP']).redact('%59%57%4A%6ASTOPY W J j');
  expect(output).not.toContain('%59%57%4A%6A');
});
