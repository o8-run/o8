import {
  closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';

export const productAnalyticsDir = () => join(getDataDir(), 'usage-analytics');
export const productSessionFile = () => join(productAnalyticsDir(), `session-${process.pid}.json`);

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
  try {
    const root = productAnalyticsDir();
    for (const name of readdirSync(root)) {
      const match = /^session-([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
      let descriptor: number | undefined;
      try {
        process.kill(pid, 0);
        descriptor = openSync(join(root, name), constants.O_RDWR | constants.O_NOFOLLOW);
        const marker = JSON.parse(readFileSync(descriptor, 'utf8')) as { pid?: unknown; enabled?: unknown };
        if (marker.pid !== pid || typeof marker.enabled !== 'boolean' || marker.enabled === enabled) continue;
        const content = JSON.stringify({ pid, enabled });
        // An open descriptor never recreates a marker removed by shutdown.
        writeSync(descriptor, content, 0, 'utf8');
        ftruncateSync(descriptor, Buffer.byteLength(content));
      } catch { /* Missing, dead, corrupt, or inaccessible: fail closed. */ }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
  } catch {
    // Local measurement must not affect application behavior.
  }
}
