/** DB-free, atomically published projection of the canonical device registry. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
export const MOBILE_DEVICE_TOKENS_PATH = path.join(DATA_DIR, 'mobile-device-tokens');

export function writeActiveTokenHashes(hashes: string[], revoked: string[] = []): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${MOBILE_DEVICE_TOKENS_PATH}.${randomUUID()}.tmp`;
  try {
    // Active lines remain compatible with existing readers. Revoked lines cannot
    // match a SHA-256 digest in those readers.
    writeFileSync(temp, [...hashes, ...revoked.map(hash => `revoked:${hash}`), ''].join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, MOBILE_DEVICE_TOKENS_PATH);
  } catch (error) {
    // Never leave an old active credential readable after a failed revocation publication.
    try { unlinkSync(MOBILE_DEVICE_TOKENS_PATH); } catch { /* unavailable */ }
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

export function readTokenProjection(): { active: Set<string>; revoked: Set<string> } {
  const active = new Set<string>();
  const revoked = new Set<string>();
  for (const line of readFileSync(MOBILE_DEVICE_TOKENS_PATH, 'utf8').split('\n').filter(Boolean)) {
    if (/^[a-f0-9]{64}$/.test(line)) active.add(line);
    else if (/^revoked:[a-f0-9]{64}$/.test(line)) revoked.add(line.slice(8));
    else throw new Error('Invalid mobile auth projection');
  }
  return { active, revoked };
}

/** Compatibility reader for non-gate consumers. */
export function readActiveTokenHashes(): Set<string> {
  // Non-auth consumers (for example credential redaction) may have no registry.
  // The HTTP gate uses readTokenProjection directly and handles failures as 503.
  try { return readTokenProjection().active; } catch { return new Set(); }
}

/** Prevent a failed canonical read from leaving a previously published active set. */
export function invalidateTokenProjection(): void {
  try { unlinkSync(MOBILE_DEVICE_TOKENS_PATH); } catch { /* already unavailable */ }
}
