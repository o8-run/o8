import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { COMPACTION_UNVERIFIED_MS, isCompactionOperation, isCompactionTerminal, type CompactionOperation } from './compaction-status';

function directory(scope: { repoPath: string; threadId: string }): string {
  const key = createHash('sha256').update(JSON.stringify([scope.repoPath, scope.threadId])).digest('hex');
  return join(getDataDir(), 'compaction-status', key);
}
/** Written before broadcast: a missing socket receipt cannot erase the outcome. */
export async function saveCompactionOperation(operation: CompactionOperation): Promise<void> {
  const dir = directory(operation);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${operation.operationId}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...operation, ownerPid: process.pid }), { mode: 0o600 });
  await rename(temporary, file);
  if (isCompactionTerminal(operation.phase)) {
    const names = (await readdir(dir)).filter(name => /^compaction-[\w-]+\.json$/.test(name));
    if (names.length > 64) {
      const old = await Promise.all(names.map(async name => ({ name, record: JSON.parse(await readFile(join(dir, name), 'utf8')) as CompactionOperation })));
      const expired = old.sort((a, b) => b.record.requestedAt - a.record.requestedAt).slice(64)
        .filter(item => isCompactionTerminal(item.record.phase));
      await Promise.all(expired.map(item => unlink(join(dir, item.name))));
    }
  }
}
export async function readCompactionOperation(scope: { repoPath: string; threadId: string }): Promise<CompactionOperation | null> {
  let names: string[];
  try { names = await readdir(directory(scope)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const records = await Promise.all(names.filter(name => /^compaction-[\w-]+\.json$/.test(name)).map(async name => {
    const record: unknown = JSON.parse(await readFile(join(directory(scope), name), 'utf8'));
    if (!isCompactionOperation(record) || record.repoPath !== scope.repoPath || record.threadId !== scope.threadId) return null;
    return record as CompactionOperation & { ownerPid: number };
  }));
  const record = records.filter((op): op is NonNullable<typeof op> => op !== null)
    .sort((a, b) => b.requestedAt - a.requestedAt || b.operationId.localeCompare(a.operationId))[0];
  if (!record) return null;
  const { ownerPid, ...operation } = record;
  if (!isCompactionTerminal(operation.phase)) {
    // A process can stop after committing history but before its final receipt.
    // Only this operation's boundary is evidence; an older summary proves nothing.
    const boundary = readPersistedLlmChat(scope.threadId)?.history.messages.find(entry => entry.compaction?.operationId === operation.operationId);
    if (boundary) return { ...operation, phase: 'complete', settledAt: boundary.compaction?.completedAt ?? operation.updatedAt };
    // A live server process is not proof that this operation is still running.
    if (Date.now() - operation.updatedAt >= COMPACTION_UNVERIFIED_MS) return { ...operation, phase: 'uncertain' };
    try { process.kill(ownerPid, 0); }
    catch { return { ...operation, phase: 'uncertain' }; }
  }
  return operation;
}
