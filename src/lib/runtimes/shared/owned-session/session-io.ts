import { revokeReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { executionRunIsClear } from '@/lib/mcp/task-execution-admission';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertOwnedSessionPath, refuseOwnedSessionPath } from './owned-path';
import { saveRestrictedOwnedSession } from './restricted-session-persistence';
import { readOwnedSessionMetadata } from './metadata-read';
import { worktreeMetadataReadLimit, WorktreeMaintenanceHeldError } from '@/lib/worktree/maintenance-budget';

import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
} from './archive';
import {
  RUNS_DIR,
  ensureDir,
  metadataPath,
  nowIso,
  pathExists,
  writeJsonFile,
} from './helpers';
import type {
  OwnedArchiveResponse,
  OwnedSessionRecord,
} from './types';
import { matchesMutationWorkspace, MutationWorkspaceNotFoundError } from '@/lib/repos/mutation-workspace';

export interface OwnedSessionIo {
  ensureRoot(): Promise<string>;
  listSessionDirs(): Promise<string[]>;
  loadSession(sessionDir: string): Promise<OwnedSessionRecord>;
  saveSession(session: OwnedSessionRecord): Promise<void>;
  findSession(surfaceId: string): Promise<OwnedSessionRecord | null>;
  findArchivedSession(surfaceId: string): Promise<OwnedSessionRecord | null>;
  archiveSession(surfaceId: string, workspace?: string): Promise<OwnedArchiveResponse>;
}

export function createOwnedSessionIo({
  root,
  surfacePrefix,
  invalidateFleetCache,
}: {
  root: string;
  surfacePrefix: string;
  invalidateFleetCache: () => void;
}): OwnedSessionIo {
  async function ensureRoot() {
    await ensureDir(path.dirname(path.resolve(root)));
    await assertOwnedSessionPath(root, root, { missing: true, kind: 'directory' });
    await ensureDir(root);
    await assertOwnedSessionPath(root, root, { kind: 'directory' });
    return root;
  }

  async function listSessionDirs() {
    const resolvedRoot = await ensureRoot();
    const entries = await readdir(resolvedRoot).catch(() => []);
    const directories: string[] = [];
    for (const name of entries) {
      const directory = path.join(resolvedRoot, name);
      try {
        const entry = await assertOwnedSessionPath(root, directory, { kind: 'entry' });
        if (entry?.isDirectory()) directories.push(directory);
      } catch { /* Unsafe entries are logged by the guard and left untouched. */ }
    }
    return directories;
  }

  async function loadSession(sessionDir: string) {
    await assertOwnedSessionPath(root, sessionDir, { kind: 'directory' });
    await assertOwnedSessionPath(root, metadataPath(sessionDir), { kind: 'file' });
    const session = await readOwnedSessionMetadata<OwnedSessionRecord>(metadataPath(sessionDir));
    if (session.surfaceId !== `${surfacePrefix}${path.basename(sessionDir)}`
      || path.resolve(session.sessionDir) !== path.resolve(sessionDir)) {
      refuseOwnedSessionPath('session metadata does not match its owned directory');
    }
    return session;
  }

  async function saveSession(session: OwnedSessionRecord) {
    await assertOwnedSessionPath(root, session.sessionDir, { kind: 'directory' });
    await assertOwnedSessionPath(root, metadataPath(session.sessionDir), { missing: true, kind: 'file' });
    session.updatedAt = nowIso();
    if (session.executionPolicy !== undefined) {
      for (const run of session.recentRuns) {
        if (run.outcome !== 'running' || run.interruptRequestedAt) revokeReadOnlyWorkerToken(run.id);
      }
      saveRestrictedOwnedSession(metadataPath(session.sessionDir), session);
      return;
    }
    await writeJsonFile(metadataPath(session.sessionDir), session, { mode: 0o600 });
  }

  async function findSession(surfaceId: string) {
    if (worktreeMetadataReadLimit() !== undefined) {
      const name = surfaceId.startsWith(surfacePrefix) ? surfaceId.slice(surfacePrefix.length) : '';
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) {
        throw new WorktreeMaintenanceHeldError(surfaceId, 'owned session has no exact directory association');
      }
      const sessionDir = path.join(root, name);
      const directory = await lstat(sessionDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!directory) return null;
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new WorktreeMaintenanceHeldError(surfaceId, 'owned session directory is redirected or invalid');
      }
      const session = await loadSession(sessionDir);
      if (session.surfaceId !== surfaceId) throw new WorktreeMaintenanceHeldError(surfaceId, 'owned session association changed');
      return session;
    }
    for (const sessionDir of await listSessionDirs()) {
      const filePath = metadataPath(sessionDir);
      if (!(await pathExists(filePath))) continue;
      const session = await loadSession(sessionDir);
      if (session.surfaceId === surfaceId) {
        return session;
      }
    }
    return null;
  }

  async function findArchivedSession(surfaceId: string): Promise<OwnedSessionRecord | null> {
    const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
    if (!archivePath) return null;
    if (!(await pathExists(metadataPath(archivePath)))) return null;
    const session = await loadSession(archivePath);
    const rebaseRun = <T extends { stdoutPath: string; stderrPath: string; stdinPath?: string }>(run: T): T => ({
      ...run,
      stdoutPath: path.join(archivePath, RUNS_DIR, path.basename(run.stdoutPath)),
      stderrPath: path.join(archivePath, RUNS_DIR, path.basename(run.stderrPath)),
      ...(run.stdinPath ? { stdinPath: path.join(archivePath, RUNS_DIR, path.basename(run.stdinPath)) } : {}),
    });
    return {
      ...session,
      sessionDir: archivePath,
      recentRuns: session.recentRuns.map(rebaseRun),
      activeRun: session.activeRun ? rebaseRun(session.activeRun) : session.activeRun,
    };
  }

  async function archiveSession(surfaceId: string, workspace?: string): Promise<OwnedArchiveResponse> {
    const session = await findSession(surfaceId);
    if (workspace !== undefined) {
      const target = session ?? await findArchivedSession(surfaceId);
      if (!target || !matchesMutationWorkspace(workspace, target.repoPath)) throw new MutationWorkspaceNotFoundError();
    }
    if (!session) {
      const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
      if (archivePath) {
        invalidateFleetCache();
        return { archived: true, archivePath, note: 'Session already archived.' };
      }
      return { archived: false, note: 'Session was not found.' };
    }

    if (session.controlledTask && (!session.recentRuns.length
      || !(await Promise.all(session.recentRuns.map(executionRunIsClear))).every(Boolean))) {
      return { archived: false, note: 'Controlled task process evidence is not clear. Stop and verify it before archive.' };
    }
    const result = await archiveOwnedSessionDir(root, session);
    if (result.archived) {
      invalidateFleetCache();
    }
    return result;
  }

  return {
    ensureRoot,
    listSessionDirs,
    loadSession,
    saveSession,
    findSession,
    findArchivedSession,
    archiveSession,
  };
}
