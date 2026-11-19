import 'server-only';

import { randomUUID } from 'node:crypto';
import { writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const PROJECTS_DIR = getDataDir();
const PROJECTS_PATH = path.join(PROJECTS_DIR, 'projects.json');

// All ledger writers share one owner queue. A rejection reaches its caller but
// must not prevent later mutations from reading the latest committed ledger.
let mutationTail: Promise<void> = Promise.resolve();
export function serializeProjectsLedgerMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(mutation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

/** Replace only a complete document; callers hold the owner queue. */
export async function writeProjectsLedgerAtomically(contents: string): Promise<void> {
  const mode = await stat(PROJECTS_PATH).then(value => value.mode & 0o777, error => {
    if (error.code === 'ENOENT') return 0o666;
    throw error;
  });
  const temporary = path.join(PROJECTS_DIR, `.projects-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode });
    await rename(temporary, PROJECTS_PATH);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
