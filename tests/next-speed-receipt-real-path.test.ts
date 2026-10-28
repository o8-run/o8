// @o8-test-browser
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
      composerPaintAcknowledged:true,sessionContentPaintAcknowledged:true,
      viewport:[1200,816], scaleFactor:2, prewarmedSessionIds:ids, switchStartSessionId:ids[1] };
    if (${JSON.stringify(mode)} === 'mismatch') result.fixtureEntries[0][0].text = 'Different fixture';
    if (${JSON.stringify(mode)} === 'truncated') result.scrollFrameMs = [];
    if (${JSON.stringify(mode)} === 'scale-factor') result.scaleFactor = 1;
    if (${JSON.stringify(mode)} === 'viewport') result.viewport = [1920,1080];
    if (${JSON.stringify(mode)} === 'cold-session') result.prewarmedSessionIds = [ids[1]];
    if (${JSON.stringify(mode)} === 'missing-conditions') delete result.prewarmedSessionIds;
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
    expect(receipt[target].viewport).toEqual([1200, 816]);
    expect(receipt[target].scaleFactor).toBe(2);
    expect(receipt[target].conditions.process).toBe('fresh-owned-process');
    expect(receipt[target].conditions.coldStartMeasured).toBe(false);
    expect(receipt[target].conditions.filesystemCache).toBe('uncontrolled-no-reset');
    expect(receipt[target].conditions.prewarmedSessionIds).toEqual(receipt.fixture.sessionIds);
    expect(receipt[target].conditions.switchStartSessionId).toBe(receipt.fixture.sessionIds[1]);
    expect(receipt[target].conditions.switchSamples).toBe('both-sessions-painted-before-sampling');
    expect(receipt[target].fixtureDigest).toBe(receipt.fixture.digest);
    expect(receipt[target].keystrokeToPaintMs).toHaveLength(20);
    expect(receipt[target].scrollFrameCostMs).toHaveLength(50);
    expect(receipt[target].switchTimeMs).toHaveLength(10);
    expect(receipt[target].memoryMiB).toBeGreaterThan(0);
  }
  expect(receipt.current.conditions.historyPolicy).toBe('retained-mounted-session-components');
  expect(receipt.next.conditions.historyPolicy).toBe('production-history-read-on-each-selection');
  expect(JSON.stringify(receipt)).not.toContain(root);
}, 90_000);

it.each(['mismatch', 'truncated', 'viewport', 'scale-factor', 'cold-session', 'missing-conditions'])('rejects %s native evidence without replacing an earlier receipt', mode => {
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
