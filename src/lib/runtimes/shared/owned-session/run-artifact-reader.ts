import { readFile, stat } from 'node:fs/promises';
import { RunArtifactCache } from './run-artifact-cache';
import type { detectRunSandboxDenial } from './sandbox-denial';
import type { OwnedRunRecord, OwnedRuntimeAdapter } from './types';

// Discovery can refresh many completed logs together. Bound their source buffers
// across stores, including reads whose parsed result is too large to cache.
let activeReads = 0;
const waitingReads: Array<() => void> = [];
const cache = new RunArtifactCache();
// Polling needs outcome metadata, not transcript entries. Keep it independently
// so scanning more logs than the transcript budget does not reread every file.
const summaries = new RunArtifactCache(1024 * 1024, 2048);
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

export function createRunArtifactReader(
  adapter: Pick<OwnedRuntimeAdapter, 'parseRunLog' | 'runtimeId'>,
  detectDenial: typeof detectRunSandboxDenial,
) {
  // Process-wide byte budgets; namespaces keep separate stores isolated.
  const namespace = `${nextReaderId++}:`;
  const rawRetentionMax = 2 * 1024 * 1024;
  return (run: OwnedRunRecord, includeStdout = true, includeEntries = true, inspectSandbox = false) => withReadSlot(async () => {
    const [stdoutKey, stderrKey] = await Promise.all([statKey(run.stdoutPath), statKey(run.stderrPath)]);
    const key = JSON.stringify([
      stdoutKey, stderrKey, run.outcome, run.finishedAt, run.interruptRequestedAt, run.childExit, run.sandboxed,
    ]);
    const cacheId = namespace + run.id;
    const prior = summaries.get(cacheId);
    const cached = includeEntries ? cache.get(cacheId) : prior;
    if (cached?.key === key && (!inspectSandbox || cached.sandboxDenial !== undefined)) {
      const [stdoutRaw, stderrRaw] = await Promise.all([
        includeStdout ? cached.stdoutRaw ?? (stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => '')) : '',
        cached.stderrRaw ?? (stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => '')),
      ]);
      return { stdoutRaw, stderrRaw, parsed: cached.parsed, sandboxDenial: cached.sandboxDenial };
    }
    const [stdoutRaw, stderrRaw] = await Promise.all([
      stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => ''),
      stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => ''),
    ]);
    const parsed = cached?.key === key ? cached.parsed : adapter.parseRunLog(stdoutRaw, run, stdoutKey === 'absent' ? undefined
      : new Date(Number(stdoutKey.slice(stdoutKey.indexOf(':') + 1))).toISOString());
    // Scan only when reconciliation requests it after the process exits.
    // Preserve a checked result across transcript reads of the same log.
    const sandboxDenial = run.sandboxDenial ?? (inspectSandbox && run.sandboxed
      ? detectDenial(adapter.runtimeId, stdoutRaw, stderrRaw)
      : prior?.key === key ? prior.sandboxDenial : undefined);
    const retained = { key, parsed, sandboxDenial,
      stdoutRaw: stdoutRaw.length + stderrRaw.length <= rawRetentionMax ? stdoutRaw : null,
      stderrRaw: stderrRaw.length <= rawRetentionMax ? stderrRaw : null };
    const summary = summaries.set(cacheId, { ...retained, stdoutRaw: null,
      parsed: { ...parsed, entries: [] } });
    const detached = includeEntries ? cache.set(cacheId, retained) : summary;
    return { stdoutRaw: includeStdout ? stdoutRaw : '', stderrRaw, parsed: detached.parsed, sandboxDenial: detached.sandboxDenial };
  });
}
