import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { completionHandoffFileIo, type HandoffFileReceipt } from './completion-handoff-io';
import { getDataDir } from '@/lib/data-dir-migration';
import type { PacketContext } from '@/lib/orchestrator/types';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { WorkspaceSessionIdentityReceipt } from '@/lib/worktree/snapshot-state';

export const COMPLETION_HANDOFF_MAX_BYTES = 16 * 1024;

export interface CompletionHandoffRecord {
  schema: 'o8/worker-completion-handoff/v1';
  repositoryUuid: string;
  packetId: string;
  laneId: string;
  missionId: string | null;
  sessionKey: string;
  worktreeId: string;
  acceptedState: 'reviewing' | 'completed' | 'failed';
  identity: WorktreeMaterializationIdentity;
  owner: {
    generation: string;
    turnCursor: number;
    attempt: number;
    storageEpoch: number;
    runId: string;
    finishedAt: string;
  };
  handoff: {
    revision: string;
    treeSha: string;
    outcome: string;
    remainingWork: string;
    evidence: { laneId: string; references: string[] };
    sessionIdentities: WorkspaceSessionIdentityReceipt[];
    recoveryInstructions: string;
  };
  context: PacketContext;
}

function privateDirectory() {
  const data = realpathSync(getDataDir());
  const directory = path.join(data, 'completion-handoffs');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (process.getuid && stat.uid !== process.getuid()) || realpathSync(directory) !== directory) {
    throw new Error('Completion handoff directory has unsafe ownership.');
  }
  return { canonicalPath: directory, device: stat.dev, inode: stat.ino };
}

function filename(repositoryUuid: string, packetId: string): string {
  return createHash('sha256').update(JSON.stringify([repositoryUuid, packetId])).digest('hex') + '.json';
}

function parseRecord(file: HandoffFileReceipt | null): CompletionHandoffRecord | null {
  if (!file) return null;
  const record = JSON.parse(file.content) as CompletionHandoffRecord;
  if (record.schema !== 'o8/worker-completion-handoff/v1' || !record.owner?.runId
    || !record.owner.generation || !record.identity?.canonicalPath
    || !Number.isSafeInteger(record.owner.turnCursor) || record.owner.turnCursor < 0
    || !Number.isSafeInteger(record.owner.attempt) || record.owner.attempt < 0
    || !Number.isSafeInteger(record.owner.storageEpoch) || record.owner.storageEpoch < 0
    || !['reviewing', 'completed', 'failed'].includes(record.acceptedState)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.handoff?.revision ?? '')
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.handoff?.treeSha ?? '')
    || record.context?.packetId !== record.packetId || record.context.sessionKey !== record.sessionKey
    || record.context.headSha !== record.handoff.revision || !record.handoff.remainingWork
    || !record.handoff.recoveryInstructions || !Array.isArray(record.handoff.evidence?.references)) {
    throw new Error('Completion handoff has an invalid owner or source receipt.');
  }
  return record;
}

function withPrivateDirectory<T>(operation: (io: (request: Parameters<typeof completionHandoffFileIo>[2]) => HandoffFileReceipt | null) => T): T {
  const directory = privateDirectory();
  const descriptor = openSync(directory.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (stat.dev !== directory.device || stat.ino !== directory.inode) throw new Error('Completion handoff directory changed while opening.');
    return operation((request) => completionHandoffFileIo(directory, descriptor, request));
  } finally { closeSync(descriptor); }
}

export function readCompletionHandoff(repositoryUuid: string, packetId: string): CompletionHandoffRecord | null {
  const record = withPrivateDirectory((io) => parseRecord(io({ operation: 'read', name: filename(repositoryUuid, packetId), maxBytes: COMPLETION_HANDOFF_MAX_BYTES })));
  if (record && (record.repositoryUuid !== repositoryUuid || record.packetId !== packetId)) {
    throw new Error('Completion handoff belongs to another packet owner.');
  }
  return record;
}

/** Called inside the owner's SQLite write barrier; checkCurrent is synchronous. */
export function publishCompletionHandoff(record: CompletionHandoffRecord, checkCurrent: () => void): CompletionHandoffRecord {
  const content = Buffer.from(JSON.stringify(record));
  if (content.length > COMPLETION_HANDOFF_MAX_BYTES) throw new Error('Completion handoff exceeds its compact bound.');
  return withPrivateDirectory((io) => {
    const destination = filename(record.repositoryUuid, record.packetId);
    checkCurrent();
    const previousFile = io({ operation: 'read', name: destination, maxBytes: COMPLETION_HANDOFF_MAX_BYTES });
    const previous = parseRecord(previousFile);
    if (previous && (previous.owner.storageEpoch > record.owner.storageEpoch
      || (previous.owner.storageEpoch === record.owner.storageEpoch
        && (previous.owner.attempt > record.owner.attempt || (previous.owner.attempt === record.owner.attempt
          && previous.owner.turnCursor > record.owner.turnCursor))))) {
      throw new Error('A newer completion handoff is already durable.');
    }
    if (previous && JSON.stringify(previous.owner) === JSON.stringify(record.owner)
      && previous.laneId === record.laneId && previous.sessionKey === record.sessionKey) {
      if (JSON.stringify(previous.identity) !== JSON.stringify(record.identity)
        || previous.handoff.revision !== record.handoff.revision || previous.handoff.treeSha !== record.handoff.treeSha) {
        throw new Error('Completed turn source changed; its handoff is immutable.');
      }
      if (previous.acceptedState === record.acceptedState) {
        // Preserve repeated captures byte-for-byte, including mtime.
        return previous;
      }
      if (previous.acceptedState !== 'reviewing' || record.acceptedState === 'reviewing') {
        throw new Error('Completed turn acceptance cannot move backwards.');
      }
    }
    const temporary = destination + '.' + randomUUID() + '.tmp';
    checkCurrent();
    const prepared = io({ operation: 'prepare', name: temporary, content: content.toString('utf8'), maxBytes: COMPLETION_HANDOFF_MAX_BYTES });
    if (!prepared) throw new Error('Completion handoff preparation has no file owner.');
    checkCurrent();
    const persisted = parseRecord(io({ operation: 'publish', name: temporary, destination,
      content: content.toString('utf8'), prepared, previous: previousFile, maxBytes: COMPLETION_HANDOFF_MAX_BYTES }));
    if (!persisted || JSON.stringify(persisted) !== content.toString('utf8')) {
      throw new Error('Completion handoff failed durable readback.');
    }
    return persisted;
  });
}
