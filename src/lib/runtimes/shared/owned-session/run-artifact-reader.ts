import { readFile, stat } from 'node:fs/promises';
import { RunArtifactCache } from './run-artifact-cache';
import type { OwnedRunRecord, OwnedRuntimeAdapter } from './types';

// Discovery can refresh many completed logs together. Bound their source buffers
// across stores, including reads whose parsed result is too large to cache.
let activeReads = 0;
const waitingReads: Array<() => void> = [];
const cache = new RunArtifactCache();
let nextReaderId = 0;

async function withReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => waitingReads.push(resolve));
  else activeReads++;
  try {
    return await read();
  } finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}

async function statKey(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

export function createRunArtifactReader(adapter: Pick<OwnedRuntimeAdapter, 'parseRunLog'>) {
  // One byte budget per process; namespaces keep separate stores isolated.
  const namespace = `${nextReaderId++}:`;
  const rawRetentionMax = 2 * 1024 * 1024;
  return (run: OwnedRunRecord, includeStdout = true) => withReadSlot(async () => {
    const [stdoutKey, stderrKey] = await Promise.all([statKey(run.stdoutPath), statKey(run.stderrPath)]);
    const key = JSON.stringify([
      stdoutKey, stderrKey, run.outcome, run.finishedAt, run.interruptRequestedAt, run.childExit,
    ]);
    const cacheId = namespace + run.id;
    const cached = cache.get(cacheId);
    if (cached?.key === key) {
      const [stdoutRaw, stderrRaw] = await Promise.all([
        includeStdout ? cached.stdoutRaw ?? (stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => '')) : '',
        cached.stderrRaw ?? (stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => '')),
      ]);
      return { stdoutRaw, stderrRaw, parsed: cached.parsed };
    }
    const [stdoutRaw, stderrRaw] = await Promise.all([
      stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => ''),
      stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => ''),
    ]);
    const parsed = adapter.parseRunLog(stdoutRaw, run, stdoutKey === 'absent' ? undefined
      : new Date(Number(stdoutKey.slice(stdoutKey.indexOf(':') + 1))).toISOString());
    const detached = cache.set(cacheId, { key, parsed,
      stdoutRaw: stdoutRaw.length + stderrRaw.length <= rawRetentionMax ? stdoutRaw : null,
      stderrRaw: stderrRaw.length <= rawRetentionMax ? stderrRaw : null });
    return { stdoutRaw: includeStdout ? stdoutRaw : '', stderrRaw, parsed: detached.parsed };
  });
}
