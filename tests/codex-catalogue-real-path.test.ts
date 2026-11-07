import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ binary: '' }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: fixture.binary, version: '1.0.0' }) }));
import { getCodexSpeedCatalogue } from '@/lib/codex/service-tier-catalogue';

let root: string;
let home: string;
let now: number;
let warning: ReturnType<typeof vi.spyOn>;
function mode(value: string) { writeFileSync(join(root, 'mode'), value); }
function reads() { return readFileSync(join(root, 'reads'), 'utf8').trim().split('\n').length; }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-catalogue-'));
  home = join(root, 'account'); mkdirSync(home);
  fixture.binary = join(root, 'codex');
  writeFileSync(fixture.binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
fs.appendFileSync(path.join(root, 'reads'), 'read\\n');
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const send = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (mode === 'never') return;
  if (request.method === 'initialize') send(request.id, {});
  if (request.method === 'config/read') send(request.id, {config: {model: 'fixture-model'}});
  if (request.method === 'model/list') {
    if (mode === 'invalid') send(request.id, {});
    else setTimeout(() => send(request.id, {data: [{model: 'fixture-model', isDefault: true, additionalSpeedTiers: ['priority']}]}), mode === 'slow' ? 7000 : 0);
  }
});
`);
  chmodSync(fixture.binary, 0o755);
  now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mode('good');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('installed Codex catalogue process and cache', () => {
  it('accepts model/list arriving after seven seconds on the first read', async () => {
    mode('slow');
    expect(await getCodexSpeedCatalogue(home)).toMatchObject({ models: { 'fixture-model': [{ id: 'default' }, { id: 'priority' }] } });
  }, 20_000);
  it('returns the last good stale catalogue when a fresh process never answers', async () => {
    const good = await getCodexSpeedCatalogue(home);
    now += 6 * 60_000; mode('never');
    expect(await getCodexSpeedCatalogue(home)).toEqual(good);
    expect(reads()).toBe(2); expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('last successful catalogue'));
  }, 20_000);
  it('still errors after the timeout when no good read exists', async () => {
    mode('never');
    await expect(getCodexSpeedCatalogue(home)).rejects.toThrow('timed out');
    expect(warning).not.toHaveBeenCalled();
  }, 20_000);
  it('keeps the five-minute cache and fresh override, and retries a failed refresh after a minute', async () => {
    const good = await getCodexSpeedCatalogue(home);
    now += 4 * 60_000; mode('invalid');
    expect(await getCodexSpeedCatalogue(home)).toEqual(good); expect(reads()).toBe(1);
    expect(await getCodexSpeedCatalogue(home, true)).toEqual(good); expect(reads()).toBe(2);
    expect(warning).toHaveBeenCalledTimes(1);
    mode('good');
    // Within the minute the fallback is served without another Codex process.
    now += 30_000;
    expect(await getCodexSpeedCatalogue(home)).toEqual(good); expect(reads()).toBe(2);
    now += 31_000;
    expect(await getCodexSpeedCatalogue(home)).toEqual(good); expect(reads()).toBe(3);
    now += 5 * 60_000;
    expect(await getCodexSpeedCatalogue(home)).toEqual(good); expect(reads()).toBe(4);
  });
  it('serves the fallback without waiting out the timeout again while Codex hangs', async () => {
    const good = await getCodexSpeedCatalogue(home);
    now += 6 * 60_000; mode('never');
    expect(await getCodexSpeedCatalogue(home)).toEqual(good); expect(reads()).toBe(2);
    const started = performance.now();
    expect(await getCodexSpeedCatalogue(home)).toEqual(good);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(reads()).toBe(2);
  }, 40_000);
  it('does not refresh the age of a fallback or reuse it for another account', async () => {
    const good = await getCodexSpeedCatalogue(home);
    now += 23 * 60 * 60_000; mode('invalid');
    expect(await getCodexSpeedCatalogue(home, true)).toEqual(good);
    now += 2 * 60 * 60_000;
    await expect(getCodexSpeedCatalogue(home, true)).rejects.toThrow('did not return a model catalogue');
    await expect(getCodexSpeedCatalogue(join(root, 'other-account'))).rejects.toThrow('did not return a model catalogue');
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
