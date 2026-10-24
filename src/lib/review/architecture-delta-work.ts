import { createHash } from 'node:crypto';

import { loadTypeScriptCompiler } from '@/lib/typescript-compiler';

import type { LaneFileChange } from '@/lib/lane/lane-diff-facts';

interface CacheEntry<T> {
  storedAt: number;
  value: T;
}

export interface ParsedSourceImports {
  content: string;
  specifiers: string[];
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createExpiringLruCache<T>(maxEntries: number, ttlMs: number) {
  const entries = new Map<string, CacheEntry<T>>();

  function prune(now: number) {
    for (const [key, entry] of entries) {
      if (now - entry.storedAt > ttlMs) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  return {
    read(key: string) {
      prune(Date.now());
      const cached = entries.get(key);
      if (!cached) return null;
      entries.delete(key);
      entries.set(key, cached);
      return cached.value;
    },
    write(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { storedAt: Date.now(), value });
      prune(Date.now());
    },
  };
}

export async function sourceImportSpecifiers(
  filePath: string,
  content: string,
  parsedImports: Map<string, ParsedSourceImports>,
) {
  const cached = parsedImports.get(filePath);
  if (cached?.content === content) return cached.specifiers;
  const specifiers = (await loadTypeScriptCompiler()).preProcessFile(content, true, true).importedFiles.map((entry) => entry.fileName);
  parsedImports.set(filePath, { content, specifiers });
  return specifiers;
}

export function architectureSnapshotCacheKey({
  repoRoot,
  baseCommit,
  workspaceState,
  changes,
  currentChangedPaths,
  contents,
  resolver,
  maxTotalBytes,
}: {
  repoRoot: string;
  baseCommit: string;
  workspaceState: string;
  changes: LaneFileChange[];
  currentChangedPaths: string[];
  contents: Map<string, string>;
  resolver: unknown;
  maxTotalBytes: number;
}) {
  const hash = createHash('sha256');
  hash.update(repoRoot);
  hash.update('\0');
  hash.update(baseCommit);
  hash.update('\0');
  hash.update(workspaceState);
  hash.update('\0');
  hash.update(JSON.stringify(changes));
  let totalBytes = 0;
  for (const filePath of currentChangedPaths) {
    const content = contents.get(filePath) ?? null;
    const size = content === null ? 0 : Buffer.byteLength(content, 'utf8');
    hash.update('\0');
    hash.update(filePath);
    hash.update('\0');
    if (content === null || totalBytes + size > maxTotalBytes) {
      hash.update('<omitted>');
    } else {
      hash.update(content);
      totalBytes += size;
    }
  }
  hash.update('\0<resolver>\0');
  hash.update(JSON.stringify(resolver));
  return hash.digest('hex');
}
