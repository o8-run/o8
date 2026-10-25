import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-speed-receipt-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const entry = 'scripts/next/speed-receipt.mjs';

function probe(mode = 'valid') {
  const binary = join(root, `native-${mode}.cjs`);
  // This probe covers only the native process seam. Recorded measurements use
  // the compiled GPUI executable, never these synthetic timing values.
  writeFileSync(binary, `#!${process.execPath}\n(async () => {
    const args = process.argv.slice(2);
    const origin = process.env.O8_NEXT_SPEED_SERVER;
    const headers = { authorization: 'Bearer ' + process.env.O8_NEXT_API_TOKEN };
    const ids = ['thoughts-composer-first', 'thoughts-composer-second'];
    const fixtureEntries = await Promise.all(ids.map(async id => {
      const response = await fetch(origin + '/api/mobile/history?sessionKey=llm-chat:' + id + '&limit=100&page=1', { headers });
      if (!response.ok) process.exit(3);
      const body = await response.json();
      return body.transcript.map(({id,role,text}) => ({id,role,text}));
    }));
    const result = { fixtureEntries, keyToFrameMs:Array(20).fill(1), scrollFrameMs:Array(50).fill(2),
      sidebarSwitchToFirstFrameMs:Array(10).fill(3), idleMemoryMiB:4, offscreen:true,
      composerPaintAcknowledged:true,sessionContentPaintAcknowledged:true };
    if (${JSON.stringify(mode)} === 'mismatch') result.fixtureEntries[0][0].text = 'Different fixture';
    if (${JSON.stringify(mode)} === 'truncated') result.scrollFrameMs = [];
    require('node:fs').writeFileSync(process.env.O8_NEXT_SPEED_OUTPUT,JSON.stringify(result));
  })().catch(() => process.exit(2));\n`);
  chmodSync(binary, 0o700);
  return binary;
}
function run(binary: string, output: string) {
  return spawnSync(process.execPath, [entry, '--binary', binary, '--output', output], { encoding: 'utf8', timeout: 90_000 });
}

it('uses canonical paths and restores composer focus after switches while writing both measurements', () => {
  const alias = join(root, 'alias');
  symlinkSync(root, alias, 'dir');
  probe();
  const output = join(alias, 'paired.json');
  const result = run(join(alias, 'native-valid.cjs'), output);
  expect(result.status, result.stderr).toBe(0);
  expect(realpathSync(output)).toBe(join(root, 'paired.json'));
  const receipt = JSON.parse(readFileSync(output, 'utf8'));
  expect(receipt.schema).toBe('o8/next-speed/v1');
  expect(receipt.fixture.sessionIds).toEqual(['thoughts-composer-first', 'thoughts-composer-second']);
  expect(receipt.fixture.digest).toMatch(/^[a-f0-9]{64}$/);
  for (const target of ['current', 'next']) {
    expect(receipt[target].fixtureDigest).toBe(receipt.fixture.digest);
    expect(receipt[target].keystrokeToPaintMs).toHaveLength(20);
    expect(receipt[target].scrollFrameCostMs).toHaveLength(50);
    expect(receipt[target].switchTimeMs).toHaveLength(10);
    expect(receipt[target].memoryMiB).toBeGreaterThan(0);
  }
  expect(JSON.stringify(receipt)).not.toContain(root);
}, 90_000);

it.each(['mismatch', 'truncated'])('rejects %s native evidence without replacing an earlier receipt', mode => {
  const output = join(root, `${mode}.json`);
  writeFileSync(output, '{"retained":true}\n');
  const result = run(probe(mode), output);
  expect(result.status).not.toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('{"retained":true}\n');
}, 90_000);

it('accepts canonical executable and output parents and refuses unknown flags before launch', () => {
  const result = spawnSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Use --binary');
  expect(() => execFileSync(process.execPath, [entry, '--binary', join(root, 'missing'), '--output', join(root, 'missing.json')], { stdio: 'pipe' })).toThrow();
});
