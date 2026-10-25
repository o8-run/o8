import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { readBoundedMaintenanceFile, worktreeMetadataReadLimit } from '@/lib/worktree/maintenance-budget';

// Session records include prompts and a bounded run history. Reject unsafe
// nodes before reading and bound allocation even if a file grows after open.
const MAX_SESSION_METADATA_BYTES = 16 * 1024 * 1024;

/** Bounded same-inode read for synchronous admission predicates; never awaits. */
export function readOwnedSessionMetadataSync<T>(filePath: string): T {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_SESSION_METADATA_BYTES) throw new Error('Owned session metadata is not a bounded regular file.');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const named = lstatSync(filePath);
    if (length !== before.size || !named.isFile() || [fstatSync(fd), named].some(entry => entry.dev !== before.dev || entry.ino !== before.ino
      || entry.size !== before.size || entry.mtimeMs !== before.mtimeMs || entry.ctimeMs !== before.ctimeMs)) throw new Error('Owned session metadata changed while reading.');
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as T;
  } finally { closeSync(fd); }
}

export async function readOwnedSessionMetadata<T>(filePath: string): Promise<T> {
  if (worktreeMetadataReadLimit() !== undefined) {
    const file = await readBoundedMaintenanceFile(filePath);
    if (!file) throw Object.assign(new Error('Owned session metadata is missing.'), { code: 'ENOENT' });
    return JSON.parse(file.text) as T;
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_SESSION_METADATA_BYTES) {
      throw new Error('Owned session metadata is not a bounded regular file.');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(filePath);
    if (length !== before.size || !named.isFile()
      || [after, named].some((stat) => stat.dev !== before.dev || stat.ino !== before.ino
        || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {
      throw new Error('Owned session metadata changed while reading.');
    }
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as T;
  } finally {
    await handle.close();
  }
}
