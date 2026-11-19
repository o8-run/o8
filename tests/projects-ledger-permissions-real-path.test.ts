import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  { existingMode: 0o660, umask: 0o077, expected: 0o660 },
  { existingMode: 0o644, umask: 0o077, expected: 0o644 },
  { existingMode: 0o664, umask: 0o000, expected: 0o664 },
  { existingMode: 0o600, umask: 0o000, expected: 0o600 },
  { existingMode: null, umask: 0o077, expected: 0o600 },
  { existingMode: null, umask: 0o022, expected: 0o644 },
  { existingMode: null, umask: 0o000, expected: 0o666 },
])('publishes $existingMode under umask $umask as $expected without exposing an incomplete temp', async options => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-ledger-permissions-')));
  try {
    // umask is process-global: change it only in this disposable subprocess.
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
      'tests/fixtures/projects-ledger-permissions.cjs', JSON.stringify(options),
    ], { cwd: process.cwd(), env: { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory }, timeout: 20_000 });
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect.soft(result.mode).toBe(options.expected);
    expect.soft(result.temporaryModes).toEqual([0o600]);
    expect(result.flags).toEqual(['wx']);
    expect(result.targetDuringWrite).toEqual([options.existingMode === null ? 'ENOENT' : '{"projects":[],"marker":"before"}']);
    expect(result.contents).toBe('{"projects":[],"marker":"after"}');
    expect(result.files.filter((file: string) => file.startsWith('.projects-'))).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
