import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The data directory resolves when ws-auth loads, so each case loads it fresh.
const saved = { ...process.env };
const directories: string[] = [];
async function load(env: { stored?: string; wsToken?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'o8-ws-auth-'));
  directories.push(directory);
  if (env.stored !== undefined) writeFileSync(join(directory, 'ws-token'), env.stored);
  delete process.env.O8_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = directory;
  if (env.wsToken === undefined) delete process.env.WS_TOKEN;
  else process.env.WS_TOKEN = env.wsToken;
  vi.resetModules();
  return { directory, auth: await import('./ws-auth') };
}

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the operator token has one source', () => {
  it('keeps a valid stored token over a different WS_TOKEN and never rewrites it', async () => {
    const stored = 'stored-operator-credential-0123456789';
    const { directory, auth } = await load({ stored, wsToken: 'environment-credential-0123456789' });
    expect(auth.getOrCreateWsToken()).toBe(stored);
    expect(auth.wsTokenFor(auth.storedWsToken(stored))).toBe(stored);
    expect(readFileSync(join(directory, 'ws-token'), 'utf8')).toBe(stored);
  });

  it('uses WS_TOKEN when no token is stored, without writing it', async () => {
    const wsToken = 'environment-credential-0123456789';
    const { directory, auth } = await load({ wsToken });
    expect(auth.wsTokenFor(null)).toBe(wsToken);
    expect(auth.getOrCreateWsToken()).toBe(wsToken);
    expect(existsSync(join(directory, 'ws-token'))).toBe(false);
  });

  it('treats a truncated stored token as absent at every verifier', async () => {
    const wsToken = 'environment-credential-0123456789';
    const { auth } = await load({ stored: 'short', wsToken });
    expect(auth.storedWsToken('short')).toBeNull();
    expect(auth.wsTokenFor(auth.storedWsToken('short'))).toBe(wsToken);
    expect(auth.getOrCreateWsToken()).toBe(wsToken);
  });
});
