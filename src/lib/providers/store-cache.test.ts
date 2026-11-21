import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(os.tmpdir(), 'o8-store-cache-'));
process.env.O8_DATA_DIR = dir;
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_MASTER_KEY = randomBytes(32).toString('base64url');
vi.mock('server-only', () => ({}));

const { encryptValueSync } = await import('@/lib/db/master-key');
const { storedProviderKey, mutateProviderKey } = await import('./key-store');
const { withProviderStoreLock } = await import('./store-lock');

const encrypted = (value: string) => { const { iv, ciphertext } = encryptValueSync(value); return `enc:${iv}:${ciphertext}`; };
/** Another process (or the Rust side) replaces the store by rename. */
function writeStoreElsewhere(lines: string[]): void {
  const temporary = join(dir, `.env.local.${Math.random()}.tmp`);
  writeFileSync(temporary, lines.join('\n'), { mode: 0o600 });
  renameSync(temporary, join(dir, '.env.local'));
}

it('reads the store once and picks up every change made by this or another process', () => {
  writeStoreElsewhere([`OPENAI_API_KEY=${encrypted('sk-first-value-0000000000')}`]);
  expect(storedProviderKey('OPENAI_API_KEY')).toBe('sk-first-value-0000000000');
  expect(storedProviderKey('OPENAI_API_KEY')).toBe('sk-first-value-0000000000');

  writeStoreElsewhere([`OPENAI_API_KEY=${encrypted('sk-second-value-000000000')}`]);
  expect(storedProviderKey('OPENAI_API_KEY')).toBe('sk-second-value-000000000');

  mutateProviderKey('OPENAI_API_KEY', { key: 'sk-third-value-0000000000' });
  expect(storedProviderKey('OPENAI_API_KEY')).toBe('sk-third-value-0000000000');

  rmSync(join(dir, '.env.local'));
  expect(storedProviderKey('OPENAI_API_KEY')).toBeNull();
});

function otherProcessCanLock(): boolean {
  const other = new Database(join(dir, '.provider-keys.lock'), { timeout: 0 });
  try { other.exec('BEGIN EXCLUSIVE'); other.exec('COMMIT'); return true; }
  catch { return false; }
  finally { other.close(); }
}

it('keeps excluding other lockers while reusing one connection, even after the lock file is replaced', () => {
  expect(withProviderStoreLock(() => otherProcessCanLock())).toBe(false);
  // Released between operations.
  expect(otherProcessCanLock()).toBe(true);
  expect(withProviderStoreLock(() => otherProcessCanLock())).toBe(false);

  rmSync(join(dir, '.provider-keys.lock'));
  expect(withProviderStoreLock(() => otherProcessCanLock())).toBe(false);
  expect(otherProcessCanLock()).toBe(true);
});
