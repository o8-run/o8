import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('serves phone catalogues with original auth, live file updates and no store or watcher owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-phone-catalog-'));
  const result = join(directory, 'receipt.json');
  try {
    await promisify(execFile)(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'tests/fixtures/phone-catalog-registration.mts', result], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
        CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
        O8_API_FRONT_DOOR: '1', O8_NEXT_O8D: '0' } });
    const receipt = JSON.parse(readFileSync(result, 'utf8'));
    if (process.env.O8_PHONE_CATALOG_REPORT) writeFileSync(process.env.O8_PHONE_CATALOG_REPORT, JSON.stringify(receipt, null, 2) + '\n');
    expect(receipt).toMatchObject({ routes: 3, authComparisons: 30, liveUpdates: true, databaseFiles: [], watchers: 0,
      loadedOpenclawOwner: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 150_000);
