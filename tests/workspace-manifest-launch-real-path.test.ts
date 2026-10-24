import type { ExecFileOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
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
const healthConnections = vi.hoisted(() => [] as number[]);
const setupServers = vi.hoisted(() => [] as Server[]);
const setupSockets = vi.hoisted(() => [] as Socket[]);
const healthMode = vi.hoisted(() => ({ value: 'tcp' as 'tcp' | 'refused' | 'http-failed' | 'http-ok' }));

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
    if (healthMode.value === 'refused') {
      callback?.(null, '', '');
      return {} as never;
    }
    const server = healthMode.value.startsWith('http') ? createHttpServer((_request, response) => {
      healthConnections.push(healthPort);
      response.writeHead(healthMode.value === 'http-failed' ? 503 : 200);
      response.end('fixture health');
    }) : createServer((socket) => {
      setupSockets.push(socket);
      healthConnections.push(healthPort);
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

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-manifest-launch-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const worktreeRoot = path.join(tempRoot, 'worktrees');
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;
const priorEnv: Record<string, string | undefined> = {};

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.sequential('workspace manifest packet launch real path', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'workspace manifest launch fixture\n');
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      setup: ['prepare-workspace'],
      services: [
        {
          name: 'api',
          command: 'exec sleep 600',
          port: { preferred: 43_300, env: 'API_PORT' },
        },
        {
          name: 'web',
          command: 'exec sleep 600',
          port: { preferred: 43_300, env: 'WEB_PORT' },
          health: { tcp: true, timeoutMs: 2_000 },
        },
      ],
      preview: { url: 'http://127.0.0.1:{{service:web}}' },
    }, null, 2));
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
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({
      productTelemetryEnabled: false,
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
      workspaceManifestPolicy: 'auto',
    });
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

  it('allocates isolated ports, injects setup env, resolves previews, and releases terminal leases', async () => {
    const { createLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import(
      '@/lib/lane/registry'
    );
    const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
    const {
      allocateWorkspaceServicePorts,
      readWorkspacePortLeases,
      releaseWorkspacePortLeases,
    } = await import('@/lib/workspace/manifest/port-leases');

    const launch = async (packetId: string, branch: string) => {
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
      // Terminal cleanup retires only a worktree whose lane names its owned session.
      const sessionKey = await bindOwnedPacketSession(repoPath, prepared.worktree, { packetId, branch });
      updateLane(lane.id, { worktreePath: prepared.cwd, sessionKey }, 'system');
      return { lane, prepared };
    };

    const first = await launch('packet-manifest-first', 'test/manifest-first');
    const second = await launch('packet-manifest-second', 'test/manifest-second');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    expect((await readWorkspaceManifestReceipt(first.prepared.cwd))?.services).toEqual([
      expect.objectContaining({ name: 'api', health: null }),
      expect.objectContaining({ name: 'web', health: expect.objectContaining({ kind: 'tcp', ok: true }) }),
    ]);
    const firstEvent = getLaneEvents(first.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    );
    const secondEvent = getLaneEvents(second.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    );
    expect(firstEvent).toBeDefined();
    expect(secondEvent).toBeDefined();

    const eventPorts = (event: NonNullable<typeof firstEvent>) => Object.fromEntries(
      (event.payload.services as Array<{ name: string; port: number }>)
        .map((service) => [service.name, service.port]),
    );
    const firstPorts = eventPorts(firstEvent!);
    const secondPorts = eventPorts(secondEvent!);
    expect(firstPorts).toEqual({ api: 43_300, web: 43_301 });
    expect(secondPorts.api).toBeGreaterThan(firstPorts.web);
    expect(secondPorts.web).toBeGreaterThan(secondPorts.api);
    expect(firstEvent?.payload.preview).toBe(`http://127.0.0.1:${firstPorts.web}`);
    expect(secondEvent?.payload.preview).toBe(`http://127.0.0.1:${secondPorts.web}`);

    const firstSetup = setupInvocations.find((invocation) => (
      invocation.cwd === first.prepared.cwd
    ));
    const secondSetup = setupInvocations.find((invocation) => (
      invocation.cwd === second.prepared.cwd
    ));
    expect(firstSetup?.env.API_PORT).toBe(String(firstPorts.api));
    expect(firstSetup?.env.WEB_PORT).toBe(String(firstPorts.web));
    expect(secondSetup?.env.API_PORT).toBe(String(secondPorts.api));
    expect(secondSetup?.env.WEB_PORT).toBe(String(secondPorts.web));
    expect(healthConnections).toEqual(expect.arrayContaining([firstPorts.web, secondPorts.web]));

    setLaneStatus(first.lane.id, 'completed', 'system', 'completed');
    await vi.waitFor(async () => {
      const leases = Object.values(await readWorkspacePortLeases());
      expect(leases.some((lease) => lease.laneId === first.lane.id)).toBe(false);
    }, { timeout: 30_000 });

    const replacement = await allocateWorkspaceServicePorts({
      packetId: 'packet-manifest-replacement',
      laneId: 'lane-manifest-replacement',
      services: [{ name: 'api', preferred: 43_300 }],
    });
    expect(replacement.api).toBe(firstPorts.api);
    await releaseWorkspacePortLeases({
      packetId: 'packet-manifest-replacement',
      laneId: 'lane-manifest-replacement',
    });

    setLaneStatus(second.lane.id, 'completed', 'system', 'completed');
    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    await vi.waitFor(async () => {
      await runWorktreeMaintenanceTick();
      expect(getLane(first.lane.id)?.worktreePath).toBeNull();
      expect(getLane(second.lane.id)?.worktreePath).toBeNull();
    }, { timeout: 60_000 });
  }, 120_000);

  it.each([
    { mode: 'refused', kind: 'tcp', failed: true, error: 'ECONNREFUSED' },
    { mode: 'http-failed', kind: 'http', failed: true, error: 'HTTP health probe returned 503.' },
    { mode: 'http-ok', kind: 'http', failed: false, error: null },
  ] as const)('settles $mode health through launch and persisted receipts', async ({ mode, kind, failed, error }) => {
    healthMode.value = mode;
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      setup: ['prepare-workspace'],
      services: [{
        name: 'web', command: 'exec sleep 600', port: { preferred: 43_400, env: 'WEB_PORT' },
        health: kind === 'tcp' ? { tcp: true, timeoutMs: 2_000 }
          : { http: 'http://127.0.0.1:{{port}}/health', timeoutMs: 2_000 },
      }],
      preview: { url: 'http://127.0.0.1:{{service:web}}' },
    }));
    execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-qm', `fixture ${mode}`], { cwd: repoPath });
    const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
    const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
    const packetId = `packet-health-${mode}`;
    const branch = `test/health-${mode}`;
    const lane = createLane({ repoPath, branch, baseBranch: 'main', runtime: 'codex', label: packetId, packetId });
    setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
    const prepared = await prepareLaunchWorktree({
      repoRoot: repoPath, agentType: 'codex', taskName: packetId, branchName: branch,
      baseBranch: 'main', isolate: true, skipSetup: true, packetId, laneId: lane.id,
    });
    expect(prepared).not.toBeNull();
    const receipt = await readWorkspaceManifestReceipt(prepared!.cwd);
    expect(receipt?.state).toBe(failed ? 'failed' : 'completed');
    expect(receipt?.finishedAt).toEqual(expect.any(String));
    expect(receipt?.services).toHaveLength(1);
    expect(receipt?.services[0]).toMatchObject({ name: 'web', health: { kind, ok: !failed } });
    expect(receipt?.services[0].health?.checkedAt).toEqual(expect.any(String));
    expect(receipt?.services[0].health?.durationMs).toBeGreaterThanOrEqual(0);
    const events = getLaneEvents(lane.id, 100);
    const applied = events.filter(event => event.verb === 'workspace_manifest_applied');
    const failures = events.filter(event => event.verb === 'workspace_manifest_failed');
    if (failed) {
      expect(receipt?.step).toBe('services');
      expect(receipt?.services[0].health?.error).toContain(error);
      expect(receipt?.error).toContain('web');
      expect(receipt?.error).toContain(error);
      expect(applied).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0].payload).toMatchObject({ step: 'services', state: 'failed' });
      expect(failures[0].payload.error).toContain('web');
      expect(failures[0].payload).not.toHaveProperty('preview');
    } else {
      expect(failures).toEqual([]);
      expect(applied).toHaveLength(1);
      expect(applied[0].payload.preview).toBe(`http://127.0.0.1:${receipt?.ports.web}`);
    }
  }, 60_000);
});
