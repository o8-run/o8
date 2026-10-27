import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readOwnedSessionMetadataSync } from './metadata-read';
import type { RuntimeLaunchIdentity } from '@/lib/runtime/identity-catalog';
import type { OwnedSessionRecord } from './types';

/** Read the same latest saved packet identity at early admission and owned launch. */
export function readPacketSessionIdentitySync(
  root: string, surfacePrefix: string, packetId: string,
): RuntimeLaunchIdentity | null {
  let directories: string[];
  const absoluteRoot = path.resolve(root);
  try {
    for (const directory of [path.dirname(absoluteRoot), absoluteRoot]) {
      const entry = lstatSync(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    }
    directories = readdirSync(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  let latest: OwnedSessionRecord | null = null;
  for (const name of directories) {
    const directory = path.join(absoluteRoot, name);
    try {
      const before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()
        || realpathSync(directory) !== path.join(canonicalRoot, name)) continue;
      const session = readOwnedSessionMetadataSync<OwnedSessionRecord>(path.join(directory, 'session.json'));
      const after = lstatSync(directory);
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || realpathSync(directory) !== path.join(canonicalRoot, name)
        || session.surfaceId !== `${surfacePrefix}${name}` || typeof session.sessionDir !== 'string'
        || path.resolve(session.sessionDir) !== directory || session.packetId !== packetId
        || typeof session.updatedAt !== 'string' || !Number.isFinite(Date.parse(session.updatedAt))
        || !session.identity || typeof session.identity.id !== 'string' || !session.identity.id
        || typeof session.identity.label !== 'string'
        || typeof session.identity.configHomeRef !== 'string' || !session.identity.configHomeRef) continue;
      if (!latest || session.updatedAt > latest.updatedAt) latest = session;
    } catch {
      // One corrupt legacy session must not hide a valid saved packet identity.
    }
  }
  return latest?.identity ?? null;
}
