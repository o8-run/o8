import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { canonical, TaskDraftError, type TaskDraftContract } from './task-draft-contract';
import type { TaskDraftAccount } from './task-draft-account';
import type { TaskDraftWorkspace } from './task-draft-workspace';

export interface TaskDraftSnapshot extends TaskDraftAccount, TaskDraftWorkspace {
  snapshotId: string; machineId: string; clientId: string; expiresAt: number;
  /** Missing only on legacy snapshots and immutable historical draft receipts. */
  catalogRevision?: string;
}
export interface TaskDraftRecord {
  version: 1;
  taskId: string;
  state: 'held';
  executionEnabled: false;
  createdAt: string;
  account: TaskDraftAccount;
  clientId: string;
  snapshot: TaskDraftSnapshot;
  contract: TaskDraftContract;
  contractHash: string;
  policy: { automaticDispatch: false; workMode: 'read-only'; packetCount: 1; maxAttempts: 1; fallback: false; executionCarrier: null };
}

export function taskDraftRoot(): string {
  return join(getDataDir(), 'plugin-task-drafts');
}
export function taskDraftKey(accountId: string, clientId: string, machineId: string, idempotencyKey: string): string {
  return createHash('sha256').update(canonical([accountId, clientId, machineId, idempotencyKey])).digest('hex');
}
export function contractHash(contract: TaskDraftContract): string {
  return createHash('sha256').update(canonical(contract)).digest('hex');
}

function directory(name: string): string {
  const dir = join(taskDraftRoot(), name);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created) syncTaskDirectories(dir);
  return dir;
}

export function syncTaskDirectories(dir: string): void {
  try {
    for (const path of new Set([dir, taskDraftRoot(), dirname(taskDraftRoot())])) {
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } catch { throw new TaskDraftError('draft_persistence_uncertain', 503); }
}

/** Publish one durable record, containing both intent binding and receipt. */
export function atomicWriteTaskState(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    published = true;
    const fdDir = openSync(dirname(file), 'r');
    try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
  } catch {
    throw new TaskDraftError(published ? 'draft_persistence_uncertain' : 'draft_store_unavailable', 503);
  } finally { rmSync(temporary, { force: true }); }
}

export function writeTaskDraftSnapshot(value: TaskDraftSnapshot): void {
  atomicWriteTaskState(join(directory('snapshots'), `${value.snapshotId}.json`), value);
}
export function readTaskDraftSnapshot(id: string): TaskDraftSnapshot {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new TaskDraftError('snapshot_unavailable', 409);
  try { return JSON.parse(readFileSync(join(directory('snapshots'), `${id}.json`), 'utf8')) as TaskDraftSnapshot; }
  catch { throw new TaskDraftError('snapshot_unavailable', 409); }
}

/** Discovery may retire snapshots, never held tasks or another app's state. */
export function invalidateTaskDraftSnapshots(account: TaskDraftAccount,
  app: { clientId: string; machineId: string }, catalogRevision: string): number {
  const dir = directory('snapshots');
  let invalidated = 0;
  for (const file of readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    let snapshot: TaskDraftSnapshot;
    try { snapshot = readTaskDraftSnapshot(file.slice(0, -5)); }
    catch { continue; }
    if (!snapshot || snapshot.accountId !== account.accountId || snapshot.clientId !== app.clientId
      || snapshot.machineId !== app.machineId) continue;
    if (snapshot.catalogRevision === catalogRevision && snapshot.epoch === account.epoch) continue;
    rmSync(join(dir, file), { force: true });
    invalidated++;
  }
  if (invalidated) syncTaskDirectories(dir);
  return invalidated;
}
export function readTaskDraft(key: string): TaskDraftRecord | null {
  const file = join(directory('intents'), `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as TaskDraftRecord;
    if (value.version !== 1 || value.executionEnabled !== false || value.state !== 'held'
      || value.contractHash !== contractHash(value.contract)) throw new Error('Invalid draft');
    return value;
  } catch { throw new TaskDraftError('draft_store_unavailable', 503); }
}
export function writeTaskDraft(key: string, record: TaskDraftRecord): void {
  // Caller holds the key lock. Existing records are immutable and never expire.
  if (readTaskDraft(key)) throw new TaskDraftError('draft_store_unavailable', 503);
  atomicWriteTaskState(join(directory('intents'), `${key}.json`), record);
}

export function findTaskDraft(taskId: string, accountId?: string): TaskDraftRecord {
  if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new TaskDraftError('task_unavailable', 404);
  const records = readdirSync(directory('intents')).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
    .map((file) => readTaskDraft(file.slice(0, -5)))
    .filter((value) => value?.taskId === taskId && (accountId === undefined || value.account.accountId === accountId));
  if (records.length !== 1) throw new TaskDraftError('task_unavailable', 404);
  return records[0]!;
}

export function listTaskDrafts(accountId: string): TaskDraftRecord[] {
  return readdirSync(directory('intents')).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
    .map((file) => readTaskDraft(file.slice(0, -5)))
    .filter((value): value is TaskDraftRecord => Boolean(value && value.account.accountId === accountId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50);
}

export async function withTaskDraftLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(directory('locks'), key);
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new TaskDraftError('draft_store_unavailable', 503);
      if (Date.now() >= deadline) throw new TaskDraftError('draft_pending', 409);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); } finally { rmSync(lock, { recursive: true }); }
}
