import type { ExecFileOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const setupInvocations = vi.hoisted(() => [] as Array<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}>);
const setupServers = vi.hoisted(() => [] as Server[]);
const setupSockets = vi.hoisted(() => [] as Socket[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[] = [],
    options: ExecFileOptions = {},
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (!args.includes('prepare-workspace')) {
      return actual.execFile(file, args, options, callback as never);
    }
    const cwd = String(options.cwd);
    const env = options.env ?? process.env;
    setupInvocations.push({ cwd, env });
    const healthPort = Number(env.WEB_PORT);
    const server = createServer((socket) => {
      setupSockets.push(socket);
      socket.end();
    });
    setupServers.push(server);
    server.once('error', (error) => callback?.(error, '', error.message));
    server.listen({ host: '127.0.0.1', port: healthPort }, () => callback?.(null, '', ''));
    return server as never;
  };
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom');
  Object.defineProperty(execFile, promisifySymbol, {
    value: (actual.execFile as unknown as Record<symbol, unknown>)[promisifySymbol],
  });
  return {
    ...actual,
    execFile,
  };
});

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-manifest-policy-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const worktreeRoot = path.join(tempRoot, 'worktrees');
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_WORKSPACE_MANIFEST_POLICY',
] as const;
const priorEnv: Record<string, string | undefined> = {};
let launchSequence = 0;

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function manifest(previewRevision: number) {
  return {
    version: 1,
    setup: ['prepare-workspace'],
    teardown: ['true'],
    services: [
      {
        name: 'api',
        command: 'exec sleep 600',
        port: { preferred: 43_400, env: 'API_PORT' },
      },
      {
        name: 'web',
        command: 'exec sleep 601',
        port: { preferred: 43_400, env: 'WEB_PORT' },
        health: { tcp: true, timeoutMs: 2_000 },
      },
    ],
    preview: { url: `http://127.0.0.1:{{service:web}}/v${previewRevision}` },
  };
}

function commitManifest(previewRevision: number): void {
  writeFileSync(
    path.join(repoPath, 'o8.workspace.json'),
    `${JSON.stringify(manifest(previewRevision), null, 2)}\n`,
  );
  execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
  execFileSync('git', [
    '-c', 'user.email=test@o8.test',
    '-c', 'user.name=o8-test',
    'commit', '-qm', `manifest revision ${previewRevision}`,
  ], { cwd: repoPath });
}

async function launchPacket(label: string) {
  launchSequence += 1;
  const packetId = `packet-manifest-policy-${launchSequence}-${label}`;
  const branch = `test/manifest-policy-${launchSequence}-${label}`;
  const { createLane, updateLane, setLaneStatus } = await import('@/lib/lane/registry');
  const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
  const lane = createLane({
    repoPath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    label: packetId,
    packetId,
  });
  setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
  const prepared = await prepareLaunchWorktree({
    repoRoot: repoPath,
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    isolate: true,
    skipSetup: true,
    packetId,
    laneId: lane.id,
  });
  if (!prepared) throw new Error(`Worktree launch returned no workspace for ${packetId}.`);
  updateLane(lane.id, { worktreePath: prepared.cwd }, 'system');
  return { lane, prepared };
}

async function expectNoManifestSideEffects(launch: Awaited<ReturnType<typeof launchPacket>>) {
  const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
  expect(setupInvocations.some((invocation) => invocation.cwd === launch.prepared.cwd)).toBe(false);
  expect(Object.values(await readWorkspacePortLeases()).some(
    (lease) => lease.laneId === launch.lane.id,
  )).toBe(false);
}

async function manifestApprovals() {
  const { listApprovals } = await import('@/lib/approvals/store');
  return listApprovals({ status: 'all', projectId: null })
    .filter((approval) => approval.toolName === 'workspace_manifest_execution');
}

describe.sequential('workspace manifest execution policy through packet launch', () => {
  beforeAll(() => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'workspace manifest policy fixture\n');
    writeFileSync(
      path.join(repoPath, 'o8.workspace.json'),
      `${JSON.stringify(manifest(1), null, 2)}\n`,
    );
    execFileSync('git', ['add', 'README.md', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '-qm', 'fixture',
    ], { cwd: repoPath });
    execFileSync('git', ['remote', 'add', 'origin', repoPath], { cwd: repoPath });

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.O8_WORKTREE_ROOT = worktreeRoot;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    delete process.env.O8_WORKSPACE_MANIFEST_POLICY;
    writeFileSync(
      path.join(dataDir, 'settings.toml'),
      '[git]\nstorage_reserve_ratio = 0.0001\nstorage_reserve_floor_gb = 0.001\n',
    );
  });

  afterAll(async () => {
    const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
    const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    for (const run of await listManagedRuns()) {
      if (run.workspaceService && run.cwd.startsWith(`${tempRoot}${path.sep}`)) await settleTerminalWorkspaceManifest(run.workspaceService);
    }
    for (const socket of setupSockets) socket.destroy();
    await Promise.all(setupServers.map(closeServer));
    const { closeDb } = await import('@/lib/db');
    closeDb();
    for (const key of controlledEnvKeys) {
      const prior = priorEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails closed by default before setup or port allocation', async () => {
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { getOperatorDefaults } = await import('@/lib/operator/defaults');
    expect((await getOperatorDefaults()).values.workspaceManifestPolicy).toBe('disabled');

    const launch = await launchPacket('default-disabled');
    const event = getLaneEvents(launch.lane.id, 100).find(
      (candidate) => candidate.verb === 'workspace_manifest_skipped',
    );
    expect(event?.payload).toMatchObject({
      policy: 'disabled',
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expectNoManifestSideEffects(launch);
    expect(await manifestApprovals()).toHaveLength(0);
  }, 60_000);

  it('applies automatically only after the operator selects auto', async () => {
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
    await updateOperatorDefaults({ workspaceManifestPolicy: 'auto' });

    const launch = await launchPacket('auto');
    expect(getLaneEvents(launch.lane.id, 100).some(
      (candidate) => candidate.verb === 'workspace_manifest_applied',
    )).toBe(true);
    expect(setupInvocations.some((invocation) => invocation.cwd === launch.prepared.cwd)).toBe(true);
    expect(Object.values(await readWorkspacePortLeases()).some(
      (lease) => lease.laneId === launch.lane.id,
    )).toBe(true);
  }, 60_000);

  it('deduplicates one approval per hash and honors approval, rejection, and hash changes', async () => {
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { resolveApproval } = await import('@/lib/approvals/resolution');
    await updateOperatorDefaults({ workspaceManifestPolicy: 'one-approval' });

    const first = await launchPacket('approval-first');
    const firstCards = await manifestApprovals();
    expect(firstCards).toHaveLength(1);
    expect(firstCards[0]).toMatchObject({
      status: 'pending',
      title: expect.stringContaining(path.basename(repoPath)),
      args: {
        kind: 'lane',
        action: 'workspace_manifest_execution',
        reason: expect.any(String),
        repoPath,
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(firstCards[0].description).toContain('prepare-workspace');
    expect(firstCards[0].description).toContain('exec sleep 600');
    expect(firstCards[0].description).toContain('exec sleep 601');
    expect(firstCards[0].description).toContain('true');
    expect(getLaneEvents(first.lane.id, 100).find(
      (candidate) => candidate.verb === 'workspace_manifest_skipped',
    )?.payload).toMatchObject({
      policy: 'one-approval',
      manifestHash: firstCards[0].args?.manifestHash,
      approvalId: firstCards[0].id,
    });
    await expectNoManifestSideEffects(first);

    const second = await launchPacket('approval-deduped');
    expect(await manifestApprovals()).toHaveLength(1);
    await expectNoManifestSideEffects(second);

    resolveApproval(firstCards[0].id, 'approve', 'test', 'Approve the exact manifest hash.');
    const approved = await launchPacket('approval-applied');
    expect(getLaneEvents(approved.lane.id, 100).some(
      (candidate) => candidate.verb === 'workspace_manifest_applied',
    )).toBe(true);
    expect(setupInvocations.some((invocation) => invocation.cwd === approved.prepared.cwd)).toBe(true);

    commitManifest(2);
    const changed = await launchPacket('changed-pending');
    const changedCards = await manifestApprovals();
    expect(changedCards).toHaveLength(2);
    const pendingChanged = changedCards.find((approval) => approval.status === 'pending');
    expect(pendingChanged?.args?.manifestHash).not.toBe(firstCards[0].args?.manifestHash);
    await expectNoManifestSideEffects(changed);

    resolveApproval(pendingChanged!.id, 'reject', 'test', 'Reject this manifest hash.');
    const rejected = await launchPacket('changed-rejected');
    expect(getLaneEvents(rejected.lane.id, 100).find(
      (candidate) => candidate.verb === 'workspace_manifest_skipped',
    )?.payload).toMatchObject({
      policy: 'one-approval',
      manifestHash: pendingChanged?.args?.manifestHash,
      approvalId: pendingChanged?.id,
      reason: 'rejected',
    });
    await expectNoManifestSideEffects(rejected);
    expect(await manifestApprovals()).toHaveLength(2);

    commitManifest(3);
    const changedAgain = await launchPacket('changed-new-card');
    const finalCards = await manifestApprovals();
    expect(finalCards).toHaveLength(3);
    expect(finalCards.filter((approval) => approval.status === 'pending')).toHaveLength(1);
    await expectNoManifestSideEffects(changedAgain);
  }, 120_000);
});
