import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';

const binary = process.env.O8D_TEST_BINARY;
const path = '/api/cortex/proposals';

function generatedCases() {
  let seed = 6411;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const cases = Array.from({ length: 100 }, (_, index) => ({
    action: 'dismiss',
    id: index % 11 === 0 ? ' \uFEFF ' : ` proposal-${next() % 13} `,
    filePattern: [' src/a.ts ', '\uFEFF日本語/修正.ts\u2029', '**/*.rs', ''][next() % 4],
    fixPattern: [' repair ', '保持順序', 'a\u0000b', '\uFEFF'][next() % 4],
  }));
  cases[0] = { action: 'dismiss', id: 'proposal-1', filePattern: 'src/main.rs', fixPattern: 'preserve saved state' };
  return cases;
}

it('replays 100 real dismiss writes and compares every response and stored ledger', async () => {
  if (!binary) throw new Error('O8D_TEST_BINARY must name the candidate or verification fixture');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-proposal-snooze-')));
  const file = join(directory, 'proposal-snooze.json');
  const initial = { version: 1, entries: [null, { id: 'broken' },
    { id: 'proposal-1', filePattern: 'old', fixPattern: 'old', snoozedUntil: 'old', retained: true },
    { id: 'proposal-1', filePattern: 'duplicate', fixPattern: 'duplicate', snoozedUntil: 'old' }] };
  type Record = { status: number; body: unknown; store: unknown };
  const records: Record[] = [];
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    await seedSessionFixture(directory);
    for (const native of [false, true]) {
      writeFileSync(file, JSON.stringify(initial));
      server = await startParityReference({ directory, nativeHttp: true, o8d: true,
        nativeSessionReads: native, binary, preload: resolve('tests/fixtures/proposal-snooze-clock.cjs') });
      await server.stopNext();
      const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
      for (const [index, body] of generatedCases().entries()) {
        const response = await fetch(origin + path, { method: 'POST',
          headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body) });
        const actual = { status: response.status, body: await response.json(),
          store: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
        if (!native) records.push(actual);
        else {
          expect(response.headers.get('x-o8d-native'), `Native route was not reached: ${path} case ${index}`).toBe('1');
          expect(actual, `case ${index}: response and persisted ledger`).toEqual(records[index]);
        }
      }
      if (!native && process.env.O8D_SNOOZE_ORACLE_OUTPUT) {
        writeFileSync(process.env.O8D_SNOOZE_ORACLE_OUTPUT, JSON.stringify({
          seed: 6411, now: 1_798_128_000_000, initial, cases: generatedCases(), records,
        }) + '\n');
      }
      await server.stop(); server = undefined;
    }
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
