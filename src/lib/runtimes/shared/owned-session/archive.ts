import { cleanupWorkerO8Cli } from './worker-o8-cli-cleanup';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withOwnedArtifactRootLock } from './artifact-admission';
import { readOwnedSessionMetadata } from './metadata-read';
import { assertOwnedSessionPath, assertOwnedSessionTree, refuseOwnedSessionPath } from './owned-path';
import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';

import { metadataPath, nowIso, writeJsonFile } from './helpers';
import type { OwnedSessionRecord, OwnedSessionState } from './types';

export interface ArchiveOwnedSessionResult {
  archived: boolean;
  archivePath?: string;
  note: string;
}

export function archiveRootForOwnedSessionRoot(root: string) {
  return `${root.replace(/\/+$/, '')}-archive`;
}

export function sessionDirNameFromSurfaceId(surfaceId: string, surfacePrefix: string) {
  const trimmed = surfaceId.trim();
  if (trimmed.startsWith(surfacePrefix)) {
    return trimmed.slice(surfacePrefix.length);
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(colonIndex + 1);
}

export async function archivedSessionPathForSurfaceId(
  root: string,
  surfaceId: string,
  surfacePrefix: string,
) {
  const sessionDirName = surfaceId.startsWith(surfacePrefix) ? surfaceId.slice(surfacePrefix.length) : '';
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(sessionDirName)) return null;
  const archivePath = path.join(archiveRootForOwnedSessionRoot(root), sessionDirName);
  const entry = await assertOwnedSessionPath(root, archivePath, { missing: true, kind: 'directory' });
  return entry ? archivePath : null;
}

export async function readOwnedSessionState(
  root: string,
  surfaceId: string,
  surfacePrefix: string,
): Promise<OwnedSessionState> {
  await assertOwnedSessionPath(root, root, { missing: true, kind: 'directory' });
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const sessionDir = path.join(root, entry.name);
    try {
      const node = await assertOwnedSessionPath(root, sessionDir, { kind: 'entry' });
      if (!node?.isDirectory()) continue;
    } catch { continue; }
    const filePath = metadataPath(sessionDir);
    if (!await assertOwnedSessionPath(root, filePath, { missing: true, kind: 'file' })) continue;
    const session = await readOwnedSessionMetadata<OwnedSessionRecord>(filePath);
    if (session.surfaceId === surfaceId) return 'active';
  }
  const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
  if (archivePath && await assertOwnedSessionPath(root, metadataPath(archivePath), { missing: true, kind: 'file' })) return 'archived';
  return 'missing';
}

export function ownedSessionRecordFingerprint(record: OwnedSessionRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** Read-only preflight, repeated under the session lock immediately before rename. */
export async function assertArchivedWorkspaceSessionRestorable(
  root: string, surfaceId: string, surfacePrefix: string, expectedFingerprint: string,
): Promise<void> {
  const name = surfaceId.startsWith(surfacePrefix) ? surfaceId.slice(surfacePrefix.length) : '';
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || !expectedFingerprint) {
    throw new Error('Archived session has no exact directory identity.');
  }
  const activePath = path.join(root, name);
  try {
    await lstat(activePath);
    throw new Error('The active session path is occupied.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const archiveRoot = archiveRootForOwnedSessionRoot(root);
  const archivePath = path.join(archiveRoot, name);
  await assertOwnedSessionPath(root, archivePath, { kind: 'directory' });
  const node = await lstat(archivePath);
  if (!node.isDirectory() || node.isSymbolicLink()
    || await realpath(archivePath) !== path.join(await realpath(archiveRoot), name)) {
    throw new Error('Archived session directory is redirected or invalid.');
  }
  const record = await readOwnedSessionMetadata<OwnedSessionRecord>(metadataPath(archivePath));
  if (record.surfaceId !== surfaceId || record.activeRun || record.detachedAt
    || path.resolve(record.sessionDir) !== path.resolve(archivePath)
    || ownedSessionRecordFingerprint(record) !== expectedFingerprint) {
    throw new Error('Archived session identity or revision changed.');
  }
}

export interface RestoreOwnedSessionResult {
  restored: boolean;
  sessionPath?: string;
  note: string;
}

/**
 * #1524 — the inverse of archiveOwnedSessionDir, for cold resume. The archive
 * is a whole-dir rename, so restoring is renaming it back: run-artifact paths
 * in the metadata were recorded absolute under the ACTIVE dir and were never
 * rewritten on archive, so they become valid again the moment the dir returns.
 * Only `sessionDir` (rewritten at archive time) needs restoring.
 */
export async function restoreArchivedOwnedSessionDir(
  root: string,
  surfaceId: string,
  surfacePrefix: string,
  strictRecordFingerprint?: string,
): Promise<RestoreOwnedSessionResult> {
  return withOwnedArtifactRootLock(root, () => restoreArchivedOwnedSessionDirLocked(root, surfaceId, surfacePrefix, strictRecordFingerprint));
}

async function restoreArchivedOwnedSessionDirLocked(
  root: string, surfaceId: string, surfacePrefix: string, strictRecordFingerprint?: string,
): Promise<RestoreOwnedSessionResult> {
  const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
  if (!archivePath) {
    return { restored: false, note: 'No archived session directory was found.' };
  }
  const activePath = path.join(root, path.basename(archivePath));
  if (await assertOwnedSessionPath(root, activePath, { missing: true, kind: 'directory' })) {
    return { restored: false, note: `Active session path already exists: ${activePath}` };
  }
  await assertOwnedSessionPath(root, root, { missing: true, kind: 'directory' });
  await mkdir(root, { recursive: true });
  if (strictRecordFingerprint) {
    await assertArchivedWorkspaceSessionRestorable(root, surfaceId, surfacePrefix, strictRecordFingerprint);
  }
  const source = await assertOwnedSessionPath(root, archivePath, { kind: 'directory' });
  await assertOwnedSessionTree(root, archivePath);
  if (await assertOwnedSessionPath(root, activePath, { missing: true, kind: 'directory' })) refuseOwnedSessionPath('active session destination became occupied');
  await assertOwnedSessionPath(root, archivePath, { kind: 'directory', identity: source! });
  await rename(archivePath, activePath);

  try {
    const activeMetadataPath = metadataPath(activePath);
    await assertOwnedSessionPath(root, activeMetadataPath, { kind: 'file' });
    const record = await readOwnedSessionMetadata<OwnedSessionRecord>(activeMetadataPath);
    await assertOwnedSessionPath(root, activeMetadataPath, { kind: 'file' });
    await writeJsonFile(activeMetadataPath, {
      ...record,
      sessionDir: activePath,
      updatedAt: nowIso(),
    }, { mode: 0o600 });
  } catch (error) {
    if (strictRecordFingerprint) throw error;
    console.warn(
      `[owned-store] Restored ${surfaceId} from archive but failed to update metadata:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { restored: true, sessionPath: activePath, note: `Session restored from archive at ${activePath}.` };
}

export async function assertOwnedSessionArchivable(root: string, sessionDir: string): Promise<boolean> {
  if (path.dirname(path.resolve(sessionDir)) !== path.resolve(root)) refuseOwnedSessionPath('session directory is outside its active owned root');
  await assertOwnedSessionTree(root, sessionDir);
  const archivePath = path.join(archiveRootForOwnedSessionRoot(root), path.basename(sessionDir));
  return !(await assertOwnedSessionPath(root, archivePath, { missing: true, kind: 'directory' }));
}

export async function archiveOwnedSessionDir(
  root: string,
  session: OwnedSessionRecord,
): Promise<ArchiveOwnedSessionResult> {
  return withOwnedArtifactRootLock(root, () => archiveOwnedSessionDirLocked(root, session));
}

async function archiveOwnedSessionDirLocked(
  root: string, session: OwnedSessionRecord,
): Promise<ArchiveOwnedSessionResult> {
  const archiveRoot = archiveRootForOwnedSessionRoot(root);
  const archivePath = path.join(archiveRoot, path.basename(session.sessionDir));

  if (path.dirname(path.resolve(session.sessionDir)) !== path.resolve(root)) refuseOwnedSessionPath('session directory is outside its active owned root');
  const source = await assertOwnedSessionPath(root, session.sessionDir, { missing: true, kind: 'directory' });
  const destination = await assertOwnedSessionPath(root, archivePath, { missing: true, kind: 'directory' });
  if (!source) {
    if (destination) {
      return { archived: true, archivePath, note: 'Session already archived.' };
    }
    return { archived: false, note: 'Session directory was not found.' };
  }

  if (destination) {
    return {
      archived: false,
      archivePath,
      note: `Archive path already exists: ${archivePath}`,
    };
  }

  await assertOwnedSessionTree(root, session.sessionDir);
  await assertOwnedSessionPath(root, archiveRoot, { missing: true, kind: 'directory' });
  await cleanupWorkerO8Cli(root, session);
  await mkdir(archiveRoot, { recursive: true });
  if (await assertOwnedSessionPath(root, archivePath, { missing: true, kind: 'directory' })) refuseOwnedSessionPath('archive session destination became occupied');
  await assertOwnedSessionPath(root, session.sessionDir, { kind: 'directory', identity: source });
  await rename(session.sessionDir, archivePath);

  try {
    const archiveMetadataPath = metadataPath(archivePath);
    await assertOwnedSessionPath(root, archiveMetadataPath, { kind: 'file' });
    const archivedSession = await readOwnedSessionMetadata<OwnedSessionRecord>(archiveMetadataPath);
    await assertOwnedSessionPath(root, archiveMetadataPath, { kind: 'file' });
    await writeJsonFile(archiveMetadataPath, {
      ...archivedSession,
      sessionDir: archivePath,
      updatedAt: nowIso(),
    }, { mode: 0o600 });
  } catch (error) {
    console.warn(
      `[owned-store] Archived ${session.surfaceId} but failed to update archived metadata:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { archived: true, archivePath, note: `Session archived at ${archivePath}.` };
}
