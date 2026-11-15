import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { IntegrationQueueError, queueRecordSchema, type QueueRecord } from './types';

export function hashInputs(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function queueRoot(create = true): string {
  const root = join(getDataDir(), 'integration-queue');
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || realpathSync(root) !== join(realpathSync(getDataDir()), 'integration-queue')) {
    throw new IntegrationQueueError('The private integration queue store is unavailable. Inspect its ownership.', 503);
  }
  return root;
}
function recordPath(repoId: string, create = false) { return join(queueRoot(create), `${hashInputs(repoId)}.json`); }
export function readQueueRecord(repoId: string): QueueRecord | null {
  try {
    const file = recordPath(repoId);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid queue file');
    const record = queueRecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (record.repoId !== repoId) throw new Error('Queue identity mismatch');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IntegrationQueueError('Integration queue state is unreadable. An operator must recover the saved record.', 503);
  }
}
/** Caller owns the repository lease. Sync before rename; readers see whole records. */
export function writeQueueRecord(record: QueueRecord): void {
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > 8 * 1024 * 1024) {
    throw new IntegrationQueueError('The integration history is at its storage bound. Preserve the saved evidence and ask an operator to archive it.', 503);
  }
  const file = recordPath(record.repoId, true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const directory = openSync(queueRoot(), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
