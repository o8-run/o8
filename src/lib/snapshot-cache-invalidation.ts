import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Shared generations keep Next and WS caches coherent without an HTTP callback. */
export function snapshotCacheInvalidation(scope: 'inbox' | 'command-center') {
  let observed: string | undefined;
  const path = () => join(getDataDir(), `snapshot-${scope}.generation`);
  function read() {
    try { return readFileSync(path(), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  return {
    publish() {
      mkdirSync(getDataDir(), { recursive: true });
      const generation = randomUUID();
      const target = path();
      const temporary = `${target}.${generation}`;
      writeFileSync(temporary, generation, { mode: 0o600 });
      renameSync(temporary, target);
      observed = generation;
    },
    changed() {
      const generation = read();
      const changed = generation !== observed;
      observed = generation;
      return changed;
    },
  };
}
