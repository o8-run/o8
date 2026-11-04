import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveTsxProcess } from '@/lib/testing/tsx-process';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-create-crash-real-path-')));
const dataDir = path.join(root, 'data');
const worktreeRoot = path.join(root, 'worktrees');
const fakeBin = path.join(root, 'bin');
const installLog = path.join(root, 'install.log');
const repoPath = path.join(root, 'repo');
const trackedSettingsBytes = '{"permissions":{"allow":["Read"]}}\n';

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function waitForFileText(
  filePath: string,
  expected: string,
  child?: ChildProcessWithoutNullStreams,
  readStderr: () => string = () => '',
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      if (text.includes(expected)) return resolve();
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        return reject(new Error(`Child exited before ${expected}: ${readStderr()}`));
      }
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${expected}: ${text}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

function createFixture(): void {
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 test');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'creation-crash-fixture',
    version: '1.0.0',
    packageManager: 'npm@11.6.2',
  }, null, 2));
  writeFileSync(path.join(repoPath, 'package-lock.json'), JSON.stringify({
    name: 'creation-crash-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'creation-crash-fixture', version: '1.0.0' },
    },
  }, null, 2));
  mkdirSync(path.join(repoPath, '.claude'));
  writeFileSync(path.join(repoPath, '.claude', 'settings.json'), trackedSettingsBytes);
  git(repoPath, 'add', 'package.json', 'package-lock.json', '.claude/settings.json');
  git(repoPath, 'commit', '-qm', 'base');

  mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, 'npm');
  writeFileSync(fakeNpm, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv.includes('--version')) { process.stdout.write('11.6.2\\n'); process.exit(0); }",
    "fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });",
    `fs.appendFileSync(${JSON.stringify(installLog)}, 'install-started:' + process.pid + '\\n');`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  chmodSync(fakeNpm, 0o755);
}

const childScript = String.raw`
void (async () => {
  const imported = await import('./src/lib/worktree/manager.ts');
  const { WorktreeManager } = imported.default ?? imported;
  await new WorktreeManager(process.env.O8_TEST_REPO).create({
    agentType: 'codex',
    taskName: 'creation crash recovery',
    branchName: 'inline/creation-crash-recovery',
    baseBranch: 'main',
    managed: true,
    packetId: 'creation-crash-recovery',
    storageAdmissionReservationId: process.env.O8_TEST_RESERVATION_ID,
    isolationPreference: 'git-worktree',
    repoSetup: {
      envMode: 'skip', envFiles: [], installCommand: 'npm ci --ignore-scripts',
      installOnCreateWorkspace: true, buildCommand: null,
      runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
      workspaceIsolationPreference: 'git-worktree',
    },
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

beforeAll(() => {
  if (process.platform !== 'win32') buildPiWriteHelper();
}, 600_000);

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('managed worktree creation crash recovery', () => {
  it('retires a SIGKILL-interrupted install without preserving runtime files and retries exactly', async () => {
    createFixture();
    const [{ getSqlite }, { StorageAdmissionStore }, rootLayout] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/worktree/root-layout'),
    ]);
    const reservationId = 'creation-crash-recovery-reservation';
    const reservation = await new StorageAdmissionStore(getSqlite()).reserve({
      mutationId: 'creation-crash-recovery-reserve',
      reservationId,
      targetPath: rootLayout.resolveManagedWorktreeStorageTarget(repoPath),
      rootIdentity: await rootLayout.observeManagedWorktreeRootIdentity(repoPath),
      exactBytes: 1,
      ownerId: 'creation-crash-recovery',
      ownerGeneration: 1,
      leaseExpiresAt: Date.now() + 60_000,
      policy: { reserveRatio: 0, absoluteFloorBytes: 0 },
    });
    expect(reservation.decision).toBe('reserved');
    const worktreeId = `packet-creation-crash-recovery${rootLayout.WORKTREE_INDEX_EXCLUSION_SUFFIX}`;
    const command = resolveTsxProcess(['--eval', childScript]);
    const child = spawn(command.file, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
        O8_TEST_INSTALL_LOG: installLog,
        O8_TEST_REPO: repoPath,
        O8_TEST_RESERVATION_ID: reservationId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await waitForFileText(installLog, 'install-started:', child, () => stderr);
    const installPid = Number(readFileSync(installLog, 'utf8').match(/install-started:(\d+)/)?.[1]);
    expect(Number.isInteger(installPid) && installPid > 0).toBe(true);
    const workspacePath = path.join(
      rootLayout.resolveWorktreeRootLayout(repoPath).primaryBase,
      worktreeId,
    );
    const meta = JSON.parse(readFileSync(
      path.join(rootLayout.resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'),
      'utf8',
    )) as { worktrees: Record<string, { status: string; creationOwner: { pid: number; identity: unknown } }> };
    const creationOwnerPid = meta.worktrees[worktreeId]!.creationOwner.pid;

    const [
      { WorktreeManager },
      { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity },
      { probeLiveProcessInside },
      { invalidateProcessCwdSnapshot },
    ] = await Promise.all([
      import('@/lib/worktree/manager'),
      import('@/lib/worktree/metadata-lock-process-identity'),
      import('@/lib/worktree/live-process-guard'),
      import('@/lib/runtime/process-cwd-snapshot'),
    ]);
    const manager = new WorktreeManager(repoPath);
    const owner = meta.worktrees[worktreeId]!.creationOwner as {
      pid: number;
      identity: Parameters<typeof sameMetadataLockProcessIdentity>[0];
    };
    expect(await probeLiveProcessInside(workspacePath)).toMatchObject({ status: 'live' });
    await expect(manager.prune(0)).resolves.not.toContain(worktreeId);
    process.kill(creationOwnerPid, 'SIGKILL');
    await waitForProcessExit(creationOwnerPid);
    await waitForExit(child);
    // The install supervisor tears down its children when the creation owner dies.
    await waitForProcessExit(installPid);
    const ownerProbe = await probeMetadataLockProcessIdentity(owner.pid);
    expect(ownerProbe.state === 'absent'
      || (ownerProbe.state === 'live'
        && !sameMetadataLockProcessIdentity(ownerProbe.identity, owner.identity))).toBe(true);
    // A separate process must protect the orphan after its owner and install exit.
    const liveProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: workspacePath,
      stdio: 'ignore',
      detached: true,
    });
    try {
      invalidateProcessCwdSnapshot();
      expect(await probeLiveProcessInside(workspacePath)).toMatchObject({ status: 'live' });
      await expect(manager.prune(0)).resolves.not.toContain(worktreeId);
      expect(existsSync(workspacePath)).toBe(true);
    } finally {
      liveProcess.kill('SIGKILL');
      await waitForExit(liveProcess);
    }
    // The machine cwd snapshot is cached for up to 15s, so a probe taken before
    // this exit still reports the pid as live. The process is confirmed gone —
    // drop the stale snapshot so the assertion reads the world, not the cache.
    invalidateProcessCwdSnapshot();
    expect(await probeLiveProcessInside(workspacePath)).toMatchObject({ status: 'clear' });
    await expect(manager.prune(0)).resolves.toContain(worktreeId);
    expect(existsSync(workspacePath)).toBe(false);
    expect(gitSucceeds(
      repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/inline/creation-crash-recovery',
    )).toBe(false);
    expect(git(repoPath, 'log', '--all', '--format=%H', '--', '.o8-install-runtime')).toBe('');

    const retried = await manager.create({
      agentType: 'codex',
      taskName: 'creation crash recovery',
      branchName: 'inline/creation-crash-recovery',
      baseBranch: 'main',
      managed: true,
      packetId: 'creation-crash-recovery',
      storageAdmissionReservationId: reservationId,
      isolationPreference: 'git-worktree',
      repoSetup: {
        envMode: 'skip', envFiles: [], installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: false, buildCommand: null,
        runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
        workspaceIsolationPreference: 'git-worktree',
      },
    });
    expect(retried).toMatchObject({
      id: worktreeId,
      path: workspacePath,
      branch: 'inline/creation-crash-recovery',
      status: 'ready',
    });
    expect(readFileSync(path.join(workspacePath, '.claude', 'settings.json'), 'utf8'))
      .toBe(trackedSettingsBytes);
    expect(existsSync(path.join(workspacePath, '.claude', 'settings.local.json'))).toBe(true);
    expect(git(workspacePath, 'status', '--porcelain', '--', '.claude/settings.local.json')).toBe('');

    const [repoRegistry, laneRegistry, lifecycle, hibernator, restorer, safetyHooks] = await Promise.all([
      import('@/lib/repos/registry'),
      import('@/lib/lane/registry'),
      import('@/lib/runtimes/shared/owned-session-lifecycle'),
      import('@/lib/workspace/hibernator'),
      import('@/lib/workspace/restorer'),
      import('@/lib/worktree/safety-hooks'),
    ]);
    const registeredRepo = await repoRegistry.addRepo(repoPath);
    await repoRegistry.updateRepo(registeredRepo.id, {
      setup: {
        ...registeredRepo.setup,
        envMode: 'skip',
        envFiles: [],
        installCommand: 'npm ci --ignore-scripts',
        installOnCreateWorkspace: false,
        workspaceIsolationPreference: 'git-worktree',
      },
    });
    writeFileSync(path.join(workspacePath, 'tracked.txt'), 'reviewed lifecycle change\n');
    git(workspacePath, 'add', 'tracked.txt');
    git(workspacePath, 'commit', '-qm', 'packet change');

    const surfaceId = 'creation-crash-recovery-owned:session';
    await manager.linkSession(retried.id, surfaceId);
    let binding = {
      surfaceId,
      runtimeId: 'codex' as const,
      sessionState: 'active' as const,
      binding: {
        logicalWorkspaceId: 'packet:creation-crash-recovery',
        repositoryUuid: null as string | null,
        packetId: 'creation-crash-recovery',
        cwd: workspacePath,
        version: 1,
        verifiedAt: '2026-08-15T00:00:00.000Z',
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    };
    lifecycle.registerOwnedSessionLifecycleHandler({
      runtimeId: 'codex',
      surfaceIdPrefix: 'creation-crash-recovery-owned:',
      commandLabel: 'safety-hook-lifecycle-proof',
      resolveRoot: () => root,
      sessionState: async () => 'active',
      archiveSession: async () => ({ archived: false, note: 'unused' }),
      getWorkspaceBinding: async () => binding,
      rebindWorkspace: async (_surfaceId, input) => {
        if (input.expectedVersion !== binding.binding.version) {
          return { status: 'conflict', receipt: binding, note: 'version mismatch' };
        }
        binding = {
          ...binding,
          binding: {
            ...binding.binding,
            repositoryUuid: input.repositoryUuid,
            packetId: input.packetId,
            cwd: path.resolve(input.nextCwd),
            version: binding.binding.version + 1,
          },
        };
        return { status: 'rebound', receipt: binding };
      },
    });
    const lane = laneRegistry.createLane({
      repoPath: registeredRepo.localPath,
      worktreePath: workspacePath,
      branch: retried.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'creation-crash-recovery',
      sessionKey: surfaceId,
      ownership: 'managed',
    });
    laneRegistry.setLaneStatus(lane.id, 'reviewing');

    const parked = await hibernator.parkWorkspace({
      repositoryUuid: registeredRepo.id,
      packetId: 'creation-crash-recovery',
      operationId: 'creation-hook-park',
    });
    expect(parked.status).toBe('parked');
    expect(existsSync(workspacePath)).toBe(false);
    const restored = await restorer.restoreWorkspace({
      repositoryUuid: registeredRepo.id,
      packetId: 'creation-crash-recovery',
      operationId: 'creation-hook-restore',
    });
    expect(restored.status).toBe('restored');
    expect(readFileSync(path.join(workspacePath, '.claude', 'settings.json'), 'utf8'))
      .toBe(trackedSettingsBytes);
    const runtime = await safetyHooks.resolveManagedWorkspaceSafetyHookRuntime();
    expect(readFileSync(path.join(workspacePath, '.claude', 'settings.local.json'), 'utf8'))
      .toBe(safetyHooks.managedWorkspaceSafetyHooksContent(runtime));
    expect(git(workspacePath, 'status', '--porcelain', '--', '.claude/settings.local.json')).toBe('');
    expect(Object.values(runtime.hookPaths).every((hookPath) => existsSync(hookPath))).toBe(true);
    expect(stderr).not.toContain('Error:');
  }, 120_000);
});
