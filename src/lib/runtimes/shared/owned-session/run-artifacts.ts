import { readFile, stat } from 'node:fs/promises';
import { withStagedStdinOutcome } from './exit-outcome';
import { stagedStdinDeliveryPath } from './staged-stdin';
import type { OwnedRunRecord, OwnedRuntimeAdapter, ParsedRunLog } from './types';

/** Include relay evidence in cache invalidation even when provider logs stop changing. */
export function createRunArtifactReader(adapter: OwnedRuntimeAdapter) {
  const runArtifactCache = new Map<string, {
    key: string;
    /** null = raw exceeded RAW_RETENTION_MAX_BYTES; re-read from disk on hit. */
    stdoutRaw: string | null;
    stderrRaw: string | null;
    parsed: ParsedRunLog;
  }>();
  const RUN_ARTIFACT_CACHE_MAX = 48;
  const RAW_RETENTION_MAX_BYTES = 2 * 1024 * 1024;
  async function statKey(filePath: string): Promise<string> {
    try {
      const info = await stat(filePath);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return 'absent';
    }
  }

  return async function readRunArtifacts(run: OwnedRunRecord) {
    const deliveryPath = run.stdinPath ? stagedStdinDeliveryPath(run.stdinPath) : undefined;
    const [stdoutKey, stderrKey, deliveryKey] = await Promise.all([
      statKey(run.stdoutPath),
      statKey(run.stderrPath),
      deliveryPath ? statKey(deliveryPath) : 'absent',
    ]);
    const key = JSON.stringify([
      stdoutKey, stderrKey, deliveryKey, run.outcome, run.finishedAt, run.interruptRequestedAt, run.childExit,
    ]);
    const cached = runArtifactCache.get(run.id);
    if (cached?.key === key) {
      runArtifactCache.delete(run.id);
      runArtifactCache.set(run.id, cached);
      if (cached.stdoutRaw !== null && cached.stderrRaw !== null) {
        return { stdoutRaw: cached.stdoutRaw, stderrRaw: cached.stderrRaw, parsed: cached.parsed };
      }
      const [rereadStdout, rereadStderr] = await Promise.all([
        cached.stdoutRaw ?? (stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => '')),
        cached.stderrRaw ?? (stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => '')),
      ]);
      return { stdoutRaw: rereadStdout, stderrRaw: rereadStderr, parsed: cached.parsed };
    }

    const [stdoutRaw, stderrRaw, deliveryRaw] = await Promise.all([
      stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => ''),
      stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => ''),
      deliveryKey === 'absent' ? '' : readFile(deliveryPath!, 'utf8'),
    ]);

    const withinRawCap = stdoutRaw.length + stderrRaw.length <= RAW_RETENTION_MAX_BYTES;
    const entry = {
      key,
      stdoutRaw: withinRawCap ? stdoutRaw : null,
      stderrRaw: withinRawCap ? stderrRaw : null,
      parsed: withStagedStdinOutcome(adapter.parseRunLog(
        stdoutRaw,
        run,
        stdoutKey === 'absent' ? undefined
          : new Date(Number(stdoutKey.slice(stdoutKey.indexOf(':') + 1))).toISOString(),
      ), deliveryRaw),
    };
    runArtifactCache.set(run.id, entry);
    while (runArtifactCache.size > RUN_ARTIFACT_CACHE_MAX) {
      const oldest = runArtifactCache.keys().next().value;
      if (oldest === undefined) break;
      runArtifactCache.delete(oldest);
    }
    return { stdoutRaw, stderrRaw, parsed: entry.parsed };
  };
}
