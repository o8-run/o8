import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const BETA_FEED_TAG = 'beta';
/** Every publisher shares this lock; a crash leaves it held for explicit recovery. */
export function acquirePublicationLock() {
  const path =
    process.env.O8_RELEASE_FEED_LOCK ||
    join(tmpdir(), 'o8-channel-publication.lock');
  const fd = openSync(path, 'wx', 0o600);
  let active = true;
  const lock = {
    release() {
      if (!active) return;
      active = false;
      process.removeListener('exit', lock.release);
      closeSync(fd);
      unlinkSync(path);
    },
  };
  process.once('exit', lock.release);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  } catch (error) {
    lock.release();
    throw error;
  }
  return lock;
}
export function compareVersions(left, right) {
  const parse = (value) => {
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    )
      throw new Error('Invalid release version.');
    return value.split('.').map(BigInt);
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
