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
    invalidateTokenProjection();
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

/**
 * An absent file means no device was ever enrolled here: an empty set, marked
 * `missing` so the gate can ask for a rebuild. Unreadable or invalid content throws.
 */
export function readTokenProjection(): { active: Set<string>; revoked: Set<string>; missing: boolean } {
  const active = new Set<string>();
  const revoked = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(MOBILE_DEVICE_TOKENS_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { active, revoked, missing: true };
    throw error;
  }
  for (const line of raw.split('\n').filter(Boolean)) {
    if (/^[a-f0-9]{64}$/.test(line)) active.add(line);
    else if (/^revoked:[a-f0-9]{64}$/.test(line)) revoked.add(line.slice(8));
    else throw new Error('Invalid mobile auth projection');
  }
  return { active, revoked, missing: false };
}

/** Compatibility reader for non-gate consumers. */
export function readActiveTokenHashes(): Set<string> {
  // Non-auth consumers (for example credential redaction) may have no registry.
  // The HTTP gate uses readTokenProjection directly and handles failures as 503.
  try { return readTokenProjection().active; } catch { return new Set(); }
}

/** Prevent a failed canonical read from leaving a previously published active set. */
export function invalidateTokenProjection(): void {
  // A marker line no reader accepts, so the gate answers "try again" and not
  // "unauthorized". Absence alone would read as "no devices".
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MOBILE_DEVICE_TOKENS_PATH, 'unavailable\n', { mode: 0o600 });
  } catch {
    try { unlinkSync(MOBILE_DEVICE_TOKENS_PATH); } catch { /* already absent */ }
  }
}
