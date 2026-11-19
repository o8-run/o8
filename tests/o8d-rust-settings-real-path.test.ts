import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// GETs proved by this public-socket test (the inventory guard reads literals).
const routes = ['/api/setup/config', '/api/runtime/provider-instances', '/api/runtime/capabilities',
  '/api/v2/keys', '/api/runtime/service-tiers', '/api/panel/operator-defaults'];
const target = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(target, 'debug', 'o8d');
it('matches 100 seeded TS requests per settings route, durable stores and auth through the public socket', async () => {
  if (!process.env.O8D_TEST_BINARY && !process.env.O8D_BINARY) {
    const { stdout } = await promisify(execFile)('df', ['-Pk', '/']);
    if (Number(stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]) < 15 * 1024 * 1024) throw new Error('15 GiB free required');
    await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml',
      '--features', 'experimental-session-reads', '--target-dir', target], { maxBuffer: 64 * 1024 * 1024 });
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-settings-parity-')));
  const result = join(directory, 'result.json');
  try {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test',
      HOME: directory, USERPROFILE: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), O8D_PARITY_SEED: process.env.O8D_PARITY_SEED,
      O8D_SETTINGS_RELEASE_RECEIPT: process.env.O8D_SETTINGS_RELEASE_RECEIPT };
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
      '--import', 'tsx', 'tests/fixtures/o8d-settings-parity.mts', binary, result],
    { cwd: process.cwd(), env, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    console.info(stdout);
    const report = JSON.parse(readFileSync(result, 'utf8'));
    expect(report.summary.map((item: { route: string }) => item.route)).toEqual(routes);
    expect(report.summary.every((item: { route: string; attempted: number; native: number; differences: number }) =>
      item.attempted >= 100 && (item.route === '/api/setup/config' ? item.native === 0 : item.native > 0) && item.differences === 0)).toBe(true);
    if (process.env.O8D_SETTINGS_REPORT) writeFileSync(process.env.O8D_SETTINGS_REPORT, JSON.stringify(report, null, 2) + '\n');
    expect(report.credentialGuard).toEqual({ setupReaderCopiesUnknownValues: true, setupProductProxied: true, keysExposeOnlyMetadata: true, ambientKeysDefer: true });
    const corpus = { seed: report.seed, records: report.records };
    const path = join(process.cwd(), 'crates/o8d/evidence/settings/corpus.json');
    if (process.env.O8D_CAPTURE_SETTINGS === '1') {
      mkdirSync(join(process.cwd(), 'crates/o8d/evidence/settings'), { recursive: true });
      writeFileSync(path, JSON.stringify(corpus, null, 2) + '\n');
    } else if (!process.env.O8D_PARITY_SEED) {
      const frozen = JSON.parse(readFileSync(path, 'utf8'));
      // Keep every body and defer oracle. Only setup's selection deliberately
      // changes: its unchecked saved fields must not become product-native.
      for (const row of frozen.records) if (row.request.path.split('?')[0] === '/api/setup/config') row.native = false;
      expect(corpus).toEqual(frozen);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 900_000);
