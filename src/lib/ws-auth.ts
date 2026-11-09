import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
export const WS_TOKEN_PATH = path.join(DATA_DIR, 'ws-token');
const TOKEN_LENGTH = 32; // 256-bit token
const MIN_TOKEN_LENGTH = 16;

/** A stored token shorter than the minimum is a truncated file, never a credential. */
export function storedWsToken(raw: string): string | null {
  const token = raw.trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

/**
 * The one rule every verifier shares (the middleware gate, request handlers and the WS
 * upgrade): a valid stored token wins, and WS_TOKEN stands in only when none is stored.
 * Every client (the desktop shell, o8d, the MCP servers) reads the stored file, so letting
 * the environment override it would split the operator's credential in two.
 */
export function wsTokenFor(stored: string | null): string | null {
  return stored ?? (process.env.WS_TOKEN?.trim() || null);
}

function readStoredWsToken(): string | null {
  try {
    if (!existsSync(WS_TOKEN_PATH)) return null;
    return storedWsToken(readFileSync(WS_TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

let warnedEnvIgnored = false;

export function getOrCreateWsToken(): string {
  const existing = readStoredWsToken();
  const envToken = process.env.WS_TOKEN?.trim();
  if (existing) {
    if (envToken && envToken !== existing && !warnedEnvIgnored) {
      warnedEnvIgnored = true;
      console.warn(`[ws-auth] WS_TOKEN differs from ${WS_TOKEN_PATH}; using the stored token so clients and verifiers agree`);
    }
    return existing;
  }
  if (envToken) return envToken;

  const token = randomBytes(TOKEN_LENGTH).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });

  try {
    writeFileSync(WS_TOKEN_PATH, token, { flag: 'wx', mode: 0o600 });
    console.log(`[ws-auth] Generated new WS auth token at ${WS_TOKEN_PATH}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrentToken = readStoredWsToken();
      if (concurrentToken) return concurrentToken;
    }
    writeFileSync(WS_TOKEN_PATH, token, { mode: 0o600 });
    console.log(`[ws-auth] Regenerated WS auth token at ${WS_TOKEN_PATH}`);
    return token;
  }
}
