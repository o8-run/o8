import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretLookup, SecretWrite } from '@/lib/providers/secret-service';

const service = vi.hoisted(() => ({
  lookup: vi.fn<() => SecretLookup>(),
  store: vi.fn<(label: string, attributes: Record<string, string>, value: string) => SecretWrite>(),
}));
vi.mock('@/lib/providers/secret-service', () => ({
  lookupSecretSync: service.lookup,
  storeSecretSync: service.store,
}));

const key = () => randomBytes(32).toString('base64url');
let dir = '';
let platform: PropertyDescriptor | undefined;

async function resolve() {
  const mod = await import('./master-key');
  mod.clearMasterKeyCache();
  return mod.resolveMasterKeySync();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'o8-master-key-linux-'));
  vi.stubEnv('O8_DATA_DIR', dir);
  vi.stubEnv('O8_MASTER_KEY', '');
  platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  service.lookup.mockReset();
  service.store.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('master key on Linux', () => {
  it('stores a first-run key in the Secret Service and writes no key file', async () => {
    let stored = '';
    service.lookup.mockReturnValueOnce({ status: 'absent' });
    service.store.mockImplementation((_label, attributes, value) => {
      expect(attributes).toEqual({ service: 'ai.o8.master-key', account: 'default' });
      stored = value;
      return { status: 'ok' };
    });
    const created = await resolve();
    expect(created).toBe(stored);
    expect(existsSync(join(dir, 'master-key'))).toBe(false);
    expect(existsSync(join(dir, 'master-key.secret-service'))).toBe(true);

    service.lookup.mockReturnValueOnce({ status: 'found', value: stored });
    expect(await resolve()).toBe(created);
  });

  it('falls back to a 0600 key file with a log line when no Secret Service runs', async () => {
    service.lookup.mockReturnValue({ status: 'unavailable', detail: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });
    const created = await resolve();
    const path = join(dir, 'master-key');
    expect(readFileSync(path, 'utf8')).toBe(created);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(service.store).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Secret Service unavailable'));
  });

  it('keeps using an existing key file and never moves it', async () => {
    const existing = key();
    writeFileSync(join(dir, 'master-key'), existing, { mode: 0o600 });
    expect(await resolve()).toBe(existing);
    expect(service.lookup).not.toHaveBeenCalled();
    expect(service.store).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'master-key'), 'utf8')).toBe(existing);
  });

  it.each<[string, SecretLookup]>([
    ['the service is unreachable', { status: 'unavailable', detail: 'no bus' }],
    ['the item is gone', { status: 'absent' }],
  ])('refuses to mint a replacement when a Secret Service key was used before and %s', async (_case, read) => {
    writeFileSync(join(dir, 'master-key.secret-service'), 'marker');
    service.lookup.mockReturnValue(read);
    await expect(resolve()).rejects.toThrow(/refusing to rotate/);
    expect(existsSync(join(dir, 'master-key'))).toBe(false);
    expect(service.store).not.toHaveBeenCalled();
  });

  it('fails loudly on a locked or refusing Secret Service', async () => {
    service.lookup.mockReturnValue({ status: 'error', detail: 'Cannot create an item in a locked collection' });
    await expect(resolve()).rejects.toThrow(/locked collection/);
    expect(existsSync(join(dir, 'master-key'))).toBe(false);
  });

  it('preserves state when the Secret Service write fails', async () => {
    service.lookup.mockReturnValue({ status: 'absent' });
    service.store.mockReturnValue({ status: 'error', detail: 'Secret Service read-back did not match' });
    await expect(resolve()).rejects.toThrow(/existing state preserved/);
    expect(existsSync(join(dir, 'master-key'))).toBe(false);
    expect(existsSync(join(dir, 'master-key.secret-service'))).toBe(false);
  });
});
