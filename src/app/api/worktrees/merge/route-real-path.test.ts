import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-mobile-publish-real-')));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const deviceToken = 'mobile-real-device-token-0123456789abcdef';
mkdirSync(dataDir);
mkdirSync(repoPath);
writeFileSync(path.join(dataDir, 'ws-token'), 'mobile-real-operator-token-0123456789abcdef\n');
writeFileSync(
  path.join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(deviceToken).digest('hex')}\n`,
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
const probes = path.join(root, 'native-cwd-probes');
mkdirSync(probes, { mode: 0o700 });
writeFileSync(path.join(process.env.O8_TEST_RUN_DATA_ROOT!, '.o8-test-run-retain.json'),
  JSON.stringify({ schema: 'o8/native-publication-fixture-retention/v1', reason: 'Preserve exact publication retirement evidence' }) + '\n',
  { mode: 0o600 });
const previousProbeRoot = process.env.O8_TEST_NATIVE_CWD_PROBE_ROOT;
const previousNodeOptions = process.env.NODE_OPTIONS;
process.env.O8_TEST_NATIVE_CWD_PROBE_ROOT = probes;
const observer = pathToFileURL(path.join(process.cwd(), 'tests/generated-output-native-cwd-observer.mjs')).href;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ');
await import(/* @vite-ignore */ observer);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.name', 'o8 test');
git(repoPath, 'config', 'user.email', 'o8-test@example.test');
writeFileSync(path.join(repoPath, 'tracked.txt'), 'reviewed\n');
git(repoPath, 'add', 'tracked.txt');
git(repoPath, 'commit', '-qm', 'reviewed');

const { closeDb } = await import('@/lib/db');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { addRepo, findRepoByLocalPath, getRepoRegistryPath } = await import('@/lib/repos/registry');
const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const {
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const { panelGateMiddleware } = await import('@/middleware');
const { createWorktreeMergePostForTesting } = await import('./handler');
const { discardExactManagedWorktree } = await import('@/lib/workspace/exact-discard');

const repo = await addRepo(repoPath);
if (getRepoRegistryPath() !== path.join(dataDir, 'repos.json')) {
  throw new Error(`Registry path escaped test data dir: ${getRepoRegistryPath()}`);
}
const ownedWorkspaceBindings = new Map<string, {
  packetId: string;
  workspacePath: string;
  live: boolean;
}>();

registerOwnedSessionLifecycleHandler({
  runtimeId: 'codex',
  surfaceIdPrefix: 'owned:mobile-real-',
  commandLabel: 'mobile-publication-test',
  resolveRoot: () => root,
  sessionState: async () => 'active',
  archiveSession: async () => ({ archived: false, note: 'unused' }),
  getWorkspaceBinding: async (surfaceId) => {
    const binding = ownedWorkspaceBindings.get(surfaceId);
    if (!binding) return null;
    const retainedRuns = binding.live ? [{
      id: `live-${binding.packetId}`,
      outcome: 'running' as const,
      pid: process.pid,
      commandIdentity: path.basename(process.execPath),
    }] : [];
    return {
      surfaceId,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${binding.packetId}`,
        repositoryUuid: repo.id,
        packetId: binding.packetId,
        cwd: binding.workspacePath,
        version: 1,
        verifiedAt: '2026-08-15T00:00:00.000Z',
      },
      activeRun: null,
      retainedRuns,
      retainedRunsComplete: true,
      retainedRunTotal: retainedRuns.length,
    };
  },
  rebindWorkspace: async () => ({ status: 'missing', receipt: null, note: 'unused' }),
});

function request(worktreeId: string, action: 'pr' | 'merge' | 'discard'): NextRequest {
  // A paired device reaches the loopback server through the relay; #4814 refuses a non-loopback Host.
  return new NextRequest('http://127.0.0.1/api/worktrees/merge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deviceToken}`,
      'content-type': 'application/json',
      'x-o8-client-addr': '192.0.2.10',
    },
    body: JSON.stringify({ repo: repoPath, worktreeId, action }),
  });
}

async function createOwnedWorkspace(label: string, createSnapshot = true) {
  const packetId = `mobile-real-${label}`;
  const worktreeId = `packet-${packetId}`;
  const workspacePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(workspacePath), { recursive: true });
  git(root, 'clone', '-q', '--local', repoPath, workspacePath);
  const lane = createLane({
    repoPath,
    worktreePath: workspacePath,
    branch: 'main',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `owned:${packetId}`,
    ownership: 'managed',
  });
  ownedWorkspaceBindings.set(lane.sessionKey!, { packetId, workspacePath, live: false });
  const head = git(workspacePath, 'rev-parse', 'HEAD');
  const recoveryRef = `refs/o8/recovery/${packetId}`;
  // A previously restored snapshot must have its actual preserved commit,
  // not only a declared recovery-ref name in the snapshot row.
  if (createSnapshot) git(repoPath, 'update-ref', recoveryRef, head);
  let snapshot = createSnapshot ? createWorkspaceSnapshot({
    repositoryUuid: repo.id,
    packetId,
    laneId: lane.id,
    originalPath: workspacePath,
    branch: 'main',
    baseCommit: head,
    headCommit: head,
    treeSha: git(workspacePath, 'rev-parse', 'HEAD^{tree}'),
    recoveryRef,
    diffFingerprint: `${packetId}-diff`,
    sessionIdentities: [{ kind: 'owned-session', identity: lane.sessionKey! }],
    creationId: `${packetId}-created`,
  }).record : null;
  if (snapshot) {
    for (const [index, state] of [
      'parkable', 'hibernating', 'parked', 'restoring', 'materialized',
    ].entries() as ArrayIterator<[number, typeof snapshot.state]>) {
      const result = transitionWorkspaceSnapshot({
        repositoryUuid: repo.id,
        packetId,
        transitionId: `${packetId}-prior-restore-${index}`,
        expectedState: snapshot.state,
        expectedVersion: snapshot.version,
        expectedGeneration: snapshot.snapshotGeneration,
        toState: state,
      });
      if (result.status !== 'applied') throw new Error('prior parked restore cycle failed');
      snapshot = result.record;
    }
  }
  const identity = lstatSync(workspacePath);
  const parentIdentity = lstatSync(path.dirname(workspacePath));
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    sessionKey: lane.sessionKey!,
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: worktreeId,
    branchName: 'main',
    status: 'ready',
    isolationKind: 'apfs-cow-clone',
    materializationIdentity: {
      device: identity.dev,
      inode: identity.ino,
      canonicalPath: realpathSync(workspacePath),
    },
    materializationParentIdentity: {
      device: parentIdentity.dev,
      inode: parentIdentity.ino,
      canonicalPath: realpathSync(path.dirname(workspacePath)),
    },
  }));
  return { packetId, worktreeId, workspacePath };
}

afterAll(() => {
  closeDb();
  if (previousProbeRoot === undefined) delete process.env.O8_TEST_NATIVE_CWD_PROBE_ROOT;
  else process.env.O8_TEST_NATIVE_CWD_PROBE_ROOT = previousProbeRoot;
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousNodeOptions;
  console.error(`[publication-fixture] retained native evidence at ${root}`);
});

describe('paired-device publication uses the captured managed workspace', () => {
  it.each(['pr', 'merge', 'discard'] as const)(
    'refuses %s when the same path is replaced after durable ownership proof',
    async (action) => {
      const fixture = await createOwnedWorkspace(action, false);
      const retained = path.join(root, `${action}-retained-owner`);
      const occupantBytes = `unrelated ${action} occupant\n`;
      const repoHead = git(repoPath, 'rev-parse', 'HEAD');
      expect(await findRepoByLocalPath(repoPath)).toMatchObject({ id: repo.id, localPath: repoPath });
      expect(panelGateMiddleware(request(fixture.worktreeId, action)).headers.get('x-middleware-next')).toBe('1');

      const response = await createWorktreeMergePostForTesting({
        afterWorkspaceMaterializationProof: () => {
          renameSync(fixture.workspacePath, retained);
          git(root, 'clone', '-q', '--local', repoPath, fixture.workspacePath);
          writeFileSync(path.join(fixture.workspacePath, 'tracked.txt'), occupantBytes);
        },
      })(request(fixture.worktreeId, action));
      const body = await response.json() as { ok: boolean; note: string };

      expect(response.status, body.note).toBe(action === 'discard' ? 409 : 200);
      expect(body.ok).toBe(false);
      expect(body.note).toContain('Managed workspace ownership changed');
      expect(readFileSync(path.join(fixture.workspacePath, 'tracked.txt'), 'utf8')).toBe(occupantBytes);
      expect(readFileSync(path.join(retained, 'tracked.txt'), 'utf8')).toBe('reviewed\n');
      expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(repoHead);
      expect(git(repoPath, 'status', '--porcelain')).toBe('');
    },
    60_000,
  );

  it.each(['pr', 'merge'] as const)(
    'preserves dirty bytes and refuses %s when the workspace commit hook rejects',
    async (action) => {
      const fixture = await createOwnedWorkspace(`commit-${action}`);
      const dirtyBytes = `dirty ${action} bytes\n`;
      writeFileSync(path.join(fixture.workspacePath, 'dirty.txt'), dirtyBytes);
      const hookPath = path.join(fixture.workspacePath, '.git', 'hooks', 'pre-commit');
      writeFileSync(hookPath, '#!/bin/sh\nexit 9\n');
      chmodSync(hookPath, 0o755);
      const repoHead = git(repoPath, 'rev-parse', 'HEAD');

      const response = await createWorktreeMergePostForTesting({})(
        request(fixture.worktreeId, action),
      );
      const body = await response.json() as { ok: boolean; note: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: false });
      expect(body.note).toContain('Workspace commit failed');
      expect(readFileSync(path.join(fixture.workspacePath, 'dirty.txt'), 'utf8')).toBe(dirtyBytes);
      expect(git(fixture.workspacePath, 'status', '--porcelain')).toContain('dirty.txt');
      expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(repoHead);
      expect(existsSync(fixture.workspacePath)).toBe(true);
    },
    30_000,
  );

  it('refuses live-worker discard before reset or clean changes a byte', async () => {
    const fixture = await createOwnedWorkspace('live-discard');
    const trackedBytes = 'live worker tracked bytes\n';
    const untrackedPath = path.join(fixture.workspacePath, 'live-untracked.txt');
    writeFileSync(path.join(fixture.workspacePath, 'tracked.txt'), trackedBytes);
    writeFileSync(untrackedPath, 'live worker untracked bytes\n');
    ownedWorkspaceBindings.get(`owned:${fixture.packetId}`)!.live = true;

    const response = await createWorktreeMergePostForTesting({})(
      request(fixture.worktreeId, 'discard'),
    );
    const body = await response.json() as { ok: boolean; note: string };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ ok: false });
    expect(body.note).toContain('process truth is live');
    expect(readFileSync(path.join(fixture.workspacePath, 'tracked.txt'), 'utf8')).toBe(trackedBytes);
    expect(readFileSync(untrackedPath, 'utf8')).toBe('live worker untracked bytes\n');
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'materialized' });
  }, 30_000);

  it.each(['pr', 'merge'] as const)(
    'reports successful %s publication with exact local cleanup still pending',
    async (action) => {
      const fixture = await createOwnedWorkspace(`cleanup-pending-${action}`);
      const retained = path.join(root, `cleanup-pending-${action}-retained-owner`);
      const occupantBytes = `cleanup-pending ${action} occupant\n`;
      const response = await createWorktreeMergePostForTesting({
        createPR: async () => ({ action: 'pr' as const, ok: true, note: 'PR created' }),
        mergeToTarget: async () => ({ action: 'merge' as const, ok: true, note: 'Merged' }),
        beforeWorkspaceCleanup: () => {
          renameSync(fixture.workspacePath, retained);
          git(root, 'clone', '-q', '--local', repoPath, fixture.workspacePath);
          writeFileSync(path.join(fixture.workspacePath, 'tracked.txt'), occupantBytes);
        },
      })(request(fixture.worktreeId, action));
      const body = await response.json() as { ok: boolean; note?: string; error?: string };

      expect(response.status, body.note ?? body.error).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.note).toContain('cleanup remains pending');
      expect(readFileSync(path.join(fixture.workspacePath, 'tracked.txt'), 'utf8')).toBe(occupantBytes);
      expect(readFileSync(path.join(retained, 'tracked.txt'), 'utf8')).toBe('reviewed\n');
      expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'materialized' });
    },
    60_000,
  );

  it.each(['pr', 'merge', 'discard'] as const)(
    'durably retires a previously restored workspace after successful %s',
    async (action) => {
      const fixture = await createOwnedWorkspace(`terminal-${action}`);
      const dependencies = {
        createPR: async () => ({ action: 'pr' as const, ok: true, note: 'PR created' }),
        mergeToTarget: async () => ({ action: 'merge' as const, ok: true, note: 'Merged' }),
      };

      const response = await createWorktreeMergePostForTesting(dependencies)(
        request(fixture.worktreeId, action),
      );
      const body = await response.json() as { ok: boolean; note?: string; error?: string };

      expect(response.status, body.note ?? body.error).toBe(200);
      expect(body.ok, body.note ?? body.error).toBe(true);
      expect(existsSync(fixture.workspacePath)).toBe(false);
      expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'retired' });
      expect(getLane(
        getWorkspaceSnapshot(repo.id, fixture.packetId)!.laneId!,
      )).toMatchObject({ status: 'archived', worktreePath: null });
    },
    // Exact native retirement repeats process, preservation and parent probes.
    120_000,
  );

  it('replays exact terminal truth after cleanup completed before the response', async () => {
    const fixture = await createOwnedWorkspace('crash-after-pr-cleanup');
    const dependencies = {
      createPR: async () => ({ action: 'pr' as const, ok: true, note: 'PR created' }),
      afterWorkspaceCleanup: async () => {
        throw new Error('simulated response crash');
      },
    };
    const first = await createWorktreeMergePostForTesting(dependencies)(
      request(fixture.worktreeId, 'pr'),
    );
    expect(first.status).toBe(500);
    expect(existsSync(fixture.workspacePath)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'retired' });

    const replay = await createWorktreeMergePostForTesting({})(
      request(fixture.worktreeId, 'pr'),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ action: 'pr', ok: true });
  }, 120_000);

  it('rolls a pre-removal discard failure back to materialized and allows an exact retry', async () => {
    const fixture = await createOwnedWorkspace('discard-reset-failure');
    let processChecks = 0;
    const refused = await createWorktreeMergePostForTesting({
      discardExact: input => discardExactManagedWorktree({
        ...input,
        processProbe: async (...args) => {
          const receipt = await input.processProbe(...args);
          // Interrupt after the actual native check, before the source rename.
          if (++processChecks === 2) throw new Error('fixture pre-removal interruption');
          return receipt;
        },
      }),
    })(
      request(fixture.worktreeId, 'discard'),
    );
    expect(refused.status).toBe(500);
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'materialized' });
    expect(existsSync(fixture.workspacePath)).toBe(true);

    const retry = await createWorktreeMergePostForTesting({})(
      request(fixture.worktreeId, 'discard'),
    );
    const body = await retry.json() as { ok: boolean; note?: string; error?: string };
    expect(retry.status, body.note ?? body.error).toBe(200);
    expect(body.ok, body.note ?? body.error).toBe(true);
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)).toMatchObject({ state: 'retired' });
    expect(existsSync(fixture.workspacePath)).toBe(false);
  }, 120_000);

  it('imports a never-parked copy-on-write head into the canonical recovery ref before retirement', async () => {
    const fixture = await createOwnedWorkspace('apfs-terminal-bootstrap', false);
    git(fixture.workspacePath, 'config', 'user.name', 'o8 test');
    git(fixture.workspacePath, 'config', 'user.email', 'o8-test@example.test');
    writeFileSync(path.join(fixture.workspacePath, 'clone-only.txt'), 'clone-only reviewed bytes\n');
    git(fixture.workspacePath, 'add', 'clone-only.txt');
    git(fixture.workspacePath, 'commit', '-qm', 'clone-only reviewed head');
    const reviewedHead = git(fixture.workspacePath, 'rev-parse', 'HEAD');
    expect(() => git(repoPath, 'cat-file', '-e', `${reviewedHead}^{commit}`)).toThrow();

    const response = await createWorktreeMergePostForTesting({})(
      request(fixture.worktreeId, 'discard'),
    );
    const body = await response.json() as { ok: boolean; note?: string; error?: string };
    expect(response.status, body.note ?? body.error).toBe(200);
    expect(body.ok, body.note ?? body.error).toBe(true);
    expect(existsSync(fixture.workspacePath)).toBe(false);

    closeDb();
    const snapshot = getWorkspaceSnapshot(repo.id, fixture.packetId);
    expect(snapshot).toMatchObject({ state: 'retired', headCommit: reviewedHead });
    expect(git(repoPath, 'rev-parse', `${snapshot!.recoveryRef}^{commit}`)).toBe(reviewedHead);
    expect(git(repoPath, 'rev-parse', `${reviewedHead}^{tree}`)).toBe(snapshot!.treeSha);
  }, 60_000);
});
