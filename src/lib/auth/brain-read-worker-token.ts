import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const PREFIX = 'o8br_';
const LIFETIME_MS = 60 * 60_000;
interface BrainReadGrant { repoPath: string; projectId: string | null; rootIdentity: string; issuedAt: number; expiresAt: number }

export const isBrainReadWorkerBearer = (token: string): boolean => token.startsWith(PREFIX);

function signingKey(create: boolean): Buffer | null {
  const directory = getDataDir();
  const file = join(directory, 'brain-read-worker-key');
  try {
    const key = readFileSync(file);
    return key.length === 32 ? key : null;
  } catch {
    if (!create) return null;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const key = randomBytes(32);
      writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
      return key;
    } catch { return signingKey(false); }
  }
}

/** One project, one hour, and only the Brain answer endpoint. */
export function mintBrainReadWorkerToken(repoPath: string, projectId: string | null, now = Date.now()): string {
  const canonical = realpathSync(repoPath);
  const root = statSync(canonical, { bigint: true });
  if (!isAbsolute(canonical) || !root.isDirectory() || !Number.isFinite(now)
    || (projectId !== null && (typeof projectId !== 'string' || !projectId.trim()))) {
    throw new Error('A valid project directory is required for Brain read admission.');
  }
  const key = signingKey(true);
  if (!key) throw new Error('Brain read credential store is unavailable.');
  const grant: BrainReadGrant = { repoPath: canonical, projectId, rootIdentity: `${root.dev}:${root.ino}`,
    issuedAt: now, expiresAt: now + LIFETIME_MS };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${PREFIX}${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** Recognition alone grants nothing, including after expiry or a bad signature. */
export function resolveBrainReadWorkerToken(token: string, now = Date.now()): BrainReadGrant | null {
  if (!isBrainReadWorkerBearer(token) || token.length > 16_384) return null;
  const [payload, signature, extra] = token.slice(PREFIX.length).split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const key = signingKey(false);
  if (!key) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const presented = Buffer.from(signature, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BrainReadGrant;
    if (typeof grant.repoPath !== 'string' || !isAbsolute(grant.repoPath)
      || (grant.projectId !== null && (typeof grant.projectId !== 'string' || !grant.projectId.trim()))
      || realpathSync(grant.repoPath) !== grant.repoPath) return null;
    const root = statSync(grant.repoPath, { bigint: true });
    return root.isDirectory() && grant.rootIdentity === `${root.dev}:${root.ino}`
      && Number.isFinite(grant.issuedAt) && Number.isFinite(grant.expiresAt)
      && grant.issuedAt <= now && grant.expiresAt > now
      && grant.expiresAt - grant.issuedAt === LIFETIME_MS ? grant : null;
  } catch { return null; }
}
