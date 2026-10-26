import {
  closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync,
  readdirSync, renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';

export const productAnalyticsDir = () => join(getDataDir(), 'usage-analytics');
export const productSessionFile = () => join(productAnalyticsDir(), `session-${process.pid}.json`);

/** Never wait for a pipe peer, follow a symlink, or read unbounded marker data. */
export function readProductSessionMarker(file: string, update?: { pid: number; enabled: boolean }): { pid?: unknown; enabled?: unknown } {
  const descriptor = openSync(file, (update === undefined ? constants.O_RDONLY : constants.O_RDWR)
    | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Invalid session marker.');
    const bytes = Buffer.alloc(129);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count === bytes.length) throw new Error('Invalid session marker.');
    const marker = JSON.parse(bytes.subarray(0, count).toString('utf8')) as { pid?: unknown; enabled?: unknown };
    if (update && marker.pid === update.pid && typeof marker.enabled === 'boolean' && marker.enabled !== update.enabled) {
      const content = JSON.stringify(update);
      // An open descriptor never recreates a marker removed by shutdown.
      writeSync(descriptor, content, 0, 'utf8');
      ftruncateSync(descriptor, Buffer.byteLength(content));
    }
    return marker;
  } finally { closeSync(descriptor); }
}

export function writeProductSession(enabled: boolean): void {
  mkdirSync(productAnalyticsDir(), { recursive: true });
  const target = productSessionFile();
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, enabled }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}

/** HTTP and backend processes share the persisted preference. Update live
 * backend markers when a gated event observes that preference changing. */
export function noteProductSessionConsent(enabled: boolean): void {
  if (!enabled) return;
  try {
    const root = productAnalyticsDir();
    for (const name of readdirSync(root)) {
      const match = /^session-([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
      try {
        process.kill(pid, 0);
        readProductSessionMarker(join(root, name), { pid, enabled });
      } catch { /* Missing, dead, corrupt, or inaccessible: fail closed. */ }
    }
  } catch {
    // Local measurement must not affect application behavior.
  }
}
