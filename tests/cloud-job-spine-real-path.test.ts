import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-cloud-job-spine-'));
const repoPath = join(dataDir, 'source-repo');
const bareRemotePath = join(dataDir, 'remote.git');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLOUD_JOB_LEASE_MS = '30000';

const runtimeRoute = await import('@/app/api/runtime/launch/route');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const controlRoute = await import('@/app/api/cloud/worker-control/route');
const taskRoute = await import('@/app/api/tasks/[taskId]/route');
const drainRoute = await import('@/app/api/panel/cloud-jobs/drain/route');
const { createCloudWorkerKey, revokeCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { listConnectedCloudWorkers, recordCloudWorkerPresence } = await import('@/lib/cloud/worker-presence');
const { getJob, readJobEvents, getLatestSessionJob, getJobDrainStatus, listJobControls, listJobs } = await import('@/lib/cloud/job-queue');
const { closeDb, getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');
const { findDispatchSessionKey, taskSessionKey } = await import('@/components/desktop/repo-focus/tabs/control-room/helpers');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo, findRepoByLocalPath } = await import('@/lib/repos/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const packetIds = [
  'packet-durable-cloud-spine',
  'packet-cloud-failure-budget',
  'packet-cloud-steer-race',
  'packet-cloud-abort-race',
  'packet-cloud-drain',
  'packet-cloud-worker-process',
  'packet-cloud-worker-restart',
  'packet-cloud-worker-abort',
  'packet-cloud-worker-reject-push',
  'packet-cloud-invalid-source',
  'packet-cloud-prebound-lane',
  'packet-cloud-task-board',
];

// External origin transport is substituted with the pinned fixture revision.
const published = await import('@/lib/cloud/published-base');
vi.spyOn(published, 'resolvePublishedCloudBase').mockImplementation(async () => execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD']).toString().trim());

beforeAll(async () => {
  mkdirSync(repoPath);
  execFileSync('git', ['init', repoPath]);
  execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'worker-test@example.invalid']);
  execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Worker Test']);
  writeFileSync(join(repoPath, 'README.md'), 'Remote worker source fixture\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, 'commit', '-m', 'test: create remote source']);
  execFileSync('git', ['init', '--bare', bareRemotePath]);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', bareRemotePath]);
  execFileSync('git', ['-C', repoPath, 'push', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', repoPath, 'remote', 'set-url', 'origin', 'https://example.invalid/worker/source.git']);
  await addRepo(repoPath);
  expect(await findRepoByLocalPath(realpathSync.native(repoPath))).toMatchObject({
    isGitRepo: true,
    remoteUrl: 'https://example.invalid/worker/source.git',
  });
  const current = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({
    ...current,
    missionId: 'mission-cloud-job-spine',
    repoPath,
    runtime: 'codex',
    packets: packetIds.map((id) => ({
      id,
      referenceLabel: id,
      title: id,
      summary: 'Exercise durable cloud worker dispatch.',
      status: 'draft',
      queueState: 'queued',
      releaseState: 'pending',
      blockedReason: null,
      lane: null,
      review: null,
      runtime: 'codex',
      workspaceTargetPath: repoPath,
      branchTarget: 'o8/cloud-spine',
      dependencyPacketIds: [],
      dependencyLabels: [],
      attemptCount: 0,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'created',
      recoveryCount: 0,
      typecheckAutoRetries: 0,
      orchestratorThreadId: null,
    })),
  } as Parameters<typeof writeOrchestratorControlPlaneState>[0]);
});

const workerKey = createCloudWorkerKey({ teamId: 'team_default', label: 'durable spine test' });

interface PollResult {
  status: number;
  body: {
    job?: {
      id: string;
      claimedBy: string;
      leaseToken: string;
      leaseExpiresAt: string;
    };
  } | null;
}

class PollChild {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = '';
  stderr = '';

  constructor(workerId: string) {
    const routeUrl = pathToFileURL(join(process.cwd(), 'src/app/api/cloud/worker-poll/route.ts')).href;
    const script = `
      import { NextRequest } from 'next/server';
      const routeModule = await import(${JSON.stringify(routeUrl)});
      const GET = routeModule.GET ?? routeModule.default?.GET;
      process.stdout.write('READY\\n');
      process.stdin.once('data', async () => {
        const request = new NextRequest(
          'http://localhost/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=' + encodeURIComponent(process.env.O8_TEST_WORKER_ID),
          { headers: { authorization: 'Bearer ' + process.env.O8_TEST_CLOUD_TOKEN } },
        );
        const response = await GET(request);
        const body = response.status === 204 ? null : await response.json();
        process.stdout.write('RESULT ' + JSON.stringify({ status: response.status, body }) + '\\n');
      });
    `;
    this.child = spawn(process.execPath, ['--import=tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
        O8_TEST_WORKER_ID: workerId,
        O8_TEST_CLOUD_TOKEN: workerKey.plaintext,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => { this.stdout += chunk; });
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
  }

  async waitFor(text: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!this.stdout.includes(text)) {
      if (this.child.exitCode !== null) {
        throw new Error(`Poll child exited before ${text}: ${this.stdout}${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${text}: ${this.stdout}${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async result(): Promise<PollResult> {
    await this.waitFor('RESULT ');
    const line = this.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
    if (!line) throw new Error(`Poll child returned no result: ${this.stdout}${this.stderr}`);
    return JSON.parse(line.slice('RESULT '.length)) as PollResult;
  }

  async waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function runtimeLaunch(body: Record<string, unknown>) {
  return runtimeRoute.POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function workerPoll(workerId: string, cursor: number = 0) {
  return pollRoute.GET(new NextRequest(
    `http://localhost/api/cloud/worker-poll?cursor=${cursor}&waitMs=0&workerId=${encodeURIComponent(workerId)}`,
    { headers: { authorization: `Bearer ${workerKey.plaintext}` } },
  ));
}

function workerStream(body: Record<string, unknown>) {
  return streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerKey.plaintext}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

function workerControl(job: {
  id: string;
  claimedBy: string;
  leaseToken: string;
}) {
  return controlRoute.GET(new NextRequest(
    `http://localhost/api/cloud/worker-control?jobId=${encodeURIComponent(job.id)}&workerId=${encodeURIComponent(job.claimedBy)}&leaseToken=${encodeURIComponent(job.leaseToken)}`,
    { headers: { authorization: `Bearer ${workerKey.plaintext}` } },
  ));
}

function acknowledgeControl(job: {
  id: string;
  claimedBy: string;
  leaseToken: string;
}, control: { id: string; deliveryToken: string }) {
  return controlRoute.POST(new NextRequest('http://localhost/api/cloud/worker-control', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerKey.plaintext}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jobId: job.id,
      workerId: job.claimedBy,
      leaseToken: job.leaseToken,
      controlId: control.id,
      deliveryToken: control.deliveryToken,
    }),
  }));
}

async function startWorkerHttpBridge() {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const disconnect = new AbortController();
      outgoing.once('close', () => disconnect.abort());
      const request = new NextRequest(`http://127.0.0.1${incoming.url ?? '/'}`, {
        method: incoming.method,
        headers: new Headers(incoming.headers as HeadersInit),
        signal: disconnect.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const pathname = new URL(request.url).pathname;
      const response = pathname === '/api/cloud/worker-poll' ? await pollRoute.GET(request)
        : pathname === '/api/cloud/worker-stream' ? await streamRoute.POST(request)
          : pathname === '/api/cloud/worker-control'
            ? incoming.method === 'POST' ? await controlRoute.POST(request) : await controlRoute.GET(request)
            : new Response('Not found', { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(error instanceof Error ? error.message : 'Worker bridge failed');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForWorkerJob(jobId: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const job = getJob('team_default', jobId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'parked') throw new Error(`Worker parked job: ${job.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for built worker to complete ${jobId}: ${JSON.stringify(getJob('team_default', jobId))}`);
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable cloud execution through the runtime launch path', () => {
  it('shows only recently authenticated and unrevoked external workers', async () => {
    const presenceKey = createCloudWorkerKey({ teamId: 'team_default', label: 'presence fixture' });
    const poll = await pollRoute.GET(new NextRequest(
      'http://localhost:3000/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=presence-fixture',
      { headers: { authorization: `Bearer ${presenceKey.plaintext}` } },
    ));
    expect(poll.status).toBe(204);
    expect(listConnectedCloudWorkers())
      .toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'presence-fixture' })]));
    closeDb();
    expect(listConnectedCloudWorkers())
      .toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'presence-fixture' })]));

    const crowdedKey = createCloudWorkerKey({ teamId: 'team_default', label: 'bounded presence fixture' });
    for (let index = 0; index < 40; index += 1) {
      recordCloudWorkerPresence({
        teamId: 'team_default', keyId: crowdedKey.record.id,
        workerId: `crowded-${index}`, nowMs: Date.now() + index,
      });
    }
    const count = getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM cloud_worker_presence WHERE key_id = ?
    `).get(crowdedKey.record.id) as { count: number };
    expect(count.count).toBeLessThanOrEqual(32);
    expect(listConnectedCloudWorkers())
      .toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'presence-fixture' })]));

    const invalid = await pollRoute.GET(new NextRequest(
      'http://localhost:3000/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=untrusted',
      { headers: { authorization: 'Bearer cwk_invalid' } },
    ));
    expect(invalid.status).toBe(401);
    revokeCloudWorkerKey(presenceKey.record.id);
    revokeCloudWorkerKey(crowdedKey.record.id);
    expect(listConnectedCloudWorkers())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'presence-fixture' })]));
  });

  it('binds the exact packet lane to the persisted cloud job', async () => {
    const packetId = 'packet-cloud-prebound-lane';
    const branchName = 'o8/cloud-prebound';
    const lane = createLane({
      repoPath,
      branch: branchName,
      baseBranch: 'main',
      runtime: 'cloud',
      packetId,
      ownership: 'managed',
    });
    setLaneStatus(lane.id, 'launching', 'system', 'dispatch');
    const before = listJobs('team_default').length;
    const mismatched = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Do not attach a different branch.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-wrong-branch',
      existingLaneId: lane.id,
      packetId,
      skipSetup: true,
      clientMutationId: 'cloud-prebound-lane-mismatch',
    });
    expect(mismatched.status).toBe(400);
    expect(listJobs('team_default')).toHaveLength(before);
    const launch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Run on this exact governed lane.',
      cwd: repoPath,
      repoPath,
      branchName,
      existingLaneId: lane.id,
      packetId,
      skipSetup: true,
      clientMutationId: 'cloud-prebound-lane-1',
    });
    expect(launch.status).toBe(200);
    const result = await launch.json() as { surfaceId: string; laneId: string };
    expect(result.laneId).toBe(lane.id);
    expect(getLane(lane.id)).toMatchObject({
      packetId,
      runtime: 'cloud',
      branch: branchName,
      sessionKey: result.surfaceId,
      status: 'running',
    });
    expect(getJob('team_default', result.surfaceId.replace(/^cloud:/, ''))).toMatchObject({
      packetId,
      launch: { laneId: lane.id, branchName },
    });
    await expect(cloudRuntime.interrupt(result.surfaceId)).resolves.toMatchObject({ ok: true });
  });

  it('reads the current packet worker attempt after reconnect without opening a stale local workspace', async () => {
    const packetId = 'packet-cloud-task-board';
    const launch = await runtimeLaunch({
      runtime: 'cloud', prompt: 'Inspect the remote task board.',
      cwd: repoPath, repoPath, branchName: 'o8/cloud-task-board', packetId,
      skipSetup: true, clientMutationId: 'cloud-task-board-1',
    });
    expect(launch.status).toBe(200);
    const launched = await launch.json() as { surfaceId: string };
    const jobId = launched.surfaceId.replace(/^cloud:/, '');
    const taskRequest = (id: string, authenticated: boolean = true) => taskRoute.GET(
      new NextRequest(`http://example.invalid/api/tasks/${id}`, {
        headers: authenticated ? { authorization: `Bearer ${getOrCreateWsToken()}` } : {},
      }),
      { params: Promise.resolve({ taskId: id }) },
    );
    const pending = await taskRequest(packetId);
    expect(pending.status).toBe(200);
    expect((await pending.json() as { task: { execution: unknown } }).task.execution).toMatchObject({
      jobId, status: 'pending', attempt: 0, workerId: null,
      workspaceAccess: 'unavailable', previewAccess: 'unavailable',
    });
    const unrelated = await taskRequest('packet-cloud-invalid-source');
    expect((await unrelated.json() as { task: { execution: unknown } }).task.execution).toBeNull();
    expect((await taskRequest(packetId, false)).status).toBe(401);

    const firstPoll = await workerPoll('task-board-first');
    expect(firstPoll.status).toBe(200);
    const firstJob = (await firstPoll.json() as { job: { id: string; leaseToken: string } }).job;
    expect(firstJob.id).toBe(jobId);
    const first = await taskRequest(packetId);
    const firstTask = (await first.json() as { task: Parameters<typeof taskSessionKey>[0] }).task;
    expect(firstTask.execution).toMatchObject({
      jobId, status: 'leased', attempt: 1, workerId: 'task-board-first', leaseState: 'active',
    });
    expect(taskSessionKey(firstTask)).toBe(launched.surfaceId);
    expect(taskSessionKey({
      ...firstTask,
      lane: firstTask.lane && { ...firstTask.lane, sessionKey: 'codex:stale-local-pane' },
    })).toBeNull();
    const oldPane = [{ sessionKey: 'codex:stale-local-pane', orchestrationPacket: { packetId } }] as
      Parameters<typeof findDispatchSessionKey>[1];
    expect(findDispatchSessionKey({
      packetId, laneId: firstTask.laneId, sessionKey: launched.surfaceId,
      requireExactSession: true, startedAt: Date.now(),
    }, oldPane)).toBeNull();

    closeDb();
    const reopened = await taskRequest(packetId);
    expect((await reopened.json() as { task: { execution: unknown } }).task.execution).toMatchObject({
      jobId, status: 'leased', attempt: 1, workerId: 'task-board-first',
    });
    // Expire the persisted claim deliberately; parallel fixture work must not
    // race a 100 ms wall-clock lease before the recovery assertions begin.
    expect(getSqlite().prepare('UPDATE cloud_jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ?')
      .run(Date.now() - 1, jobId, firstJob.leaseToken).changes).toBe(1);
    const expired = await taskRequest(packetId);
    expect((await expired.json() as { task: { execution: unknown } }).task.execution).toMatchObject({
      jobId, status: 'leased', attempt: 1, workerId: null, leaseState: 'expired',
    });
    const secondPoll = await workerPoll('task-board-second');
    expect(secondPoll.status).toBe(200);
    const secondJob = (await secondPoll.json() as {
      job: { id: string; claimedBy: string; leaseToken: string };
    }).job;
    expect(secondJob.id).toBe(jobId);
    const reassigned = await taskRequest(packetId);
    expect((await reassigned.json() as { task: { execution: unknown } }).task.execution).toMatchObject({
      jobId, status: 'leased', attempt: 2, workerId: 'task-board-second', leaseState: 'active',
    });
    const completion = await workerStream({
      jobId, workerId: secondJob.claimedBy, leaseToken: secondJob.leaseToken,
      type: 'completed', payload: { text: 'Task board fixture complete.' },
    });
    expect(completion.status).toBe(200);
    const completed = await taskRequest(packetId);
    expect((await completed.json() as { task: { execution: unknown } }).task.execution).toMatchObject({
      jobId, status: 'completed', attempt: 2, workerId: null, leaseState: 'none',
    });
    const localLane = createLane({
      repoPath, branch: 'o8/local-after-cloud', runtime: 'codex', packetId,
      sessionKey: 'codex:current-local-pane', ownership: 'managed',
    });
    setLaneStatus(localLane.id, 'launching', 'system', 'dispatch');
    setLaneStatus(localLane.id, 'running', 'system', 'dispatch');
    const localTaskResponse = await taskRequest(packetId);
    const localTask = (await localTaskResponse.json() as { task: Parameters<typeof taskSessionKey>[0] }).task;
    expect(localTask.runtime).toBe('codex');
    expect(localTask.execution).toBeNull();
    expect(taskSessionKey(localTask)).toBe('codex:current-local-pane');
  });

  it('rejects invalid remote source before enqueueing a worker job', async () => {
    const before = listJobs('team_default').length;
    const response = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Do not run against an invalid branch.',
      cwd: repoPath,
      repoPath,
      branchName: '../invalid',
      skipSetup: true,
      packetId: 'packet-cloud-invalid-source',
      clientMutationId: 'cloud-invalid-source-1',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      surfaceId: '',
      note: 'The assigned remote branch is invalid.',
    });
    expect(listJobs('team_default')).toHaveLength(before);
  });

  it('survives restart, serializes claims, recovers a lease, and retains output', async () => {
    const packetId = 'packet-durable-cloud-spine';
    const launch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Produce durable remote output.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-spine',
      skipSetup: true,
      packetId,
      clientMutationId: 'cloud-spine-launch-1',
    });
    expect(launch.status).toBe(200);
    const launchBody = await launch.json() as { surfaceId: string; laneId: string };
    const jobId = launchBody.surfaceId.replace(/^cloud:/, '');
    expect(getLane(launchBody.laneId)).toMatchObject({
      packetId,
      runtime: 'cloud',
      sessionKey: launchBody.surfaceId,
    });

    const duplicatePacket = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'This packet must not run concurrently.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-spine',
      skipSetup: true,
      packetId,
      clientMutationId: 'cloud-spine-launch-2',
    });
    expect(duplicatePacket.status).toBe(400);
    await expect(duplicatePacket.json()).resolves.toMatchObject({
      ok: false,
      surfaceId: launchBody.surfaceId,
      note: expect.stringContaining('already has active cloud job'),
    });

    closeDb();
    expect(getJob('team_default', jobId)).toMatchObject({
      id: jobId,
      packetId,
      status: 'pending',
      executionAttempts: 0,
    });

    const otherTeamKey = createCloudWorkerKey({ teamId: 'team_other', label: 'other team fixture' });
    const wrongTeamPoll = await pollRoute.GET(new NextRequest(
      'http://localhost/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=other-team',
      { headers: { authorization: `Bearer ${otherTeamKey.plaintext}` } },
    ));
    expect(wrongTeamPoll.status).toBe(204);
    const wrongTeamEvent = await streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
      method: 'POST',
      headers: { authorization: `Bearer ${otherTeamKey.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, workerId: 'other-team', leaseToken: 'not-owned', type: 'completed', payload: { result: 'forged' } }),
    }));
    expect(wrongTeamEvent.status).toBe(403);
    const revokedKey = createCloudWorkerKey({ teamId: 'team_default', label: 'revoked fixture' });
    revokeCloudWorkerKey(revokedKey.record.id);
    const revokedPoll = await pollRoute.GET(new NextRequest(
      'http://localhost/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=revoked',
      { headers: { authorization: `Bearer ${revokedKey.plaintext}` } },
    ));
    expect(revokedPoll.status).toBe(403);

    const contenders = [new PollChild('worker-a'), new PollChild('worker-b')];
    await Promise.all(contenders.map((child) => child.waitFor('READY')));
    for (const child of contenders) child.child.stdin.end('go\n');
    const results = await Promise.all(contenders.map((child) => child.result()));
    await Promise.all(contenders.map((child) => child.waitForExit()));

    expect(results.map((result) => result.status).sort()).toEqual([200, 204]);
    const firstClaim = results.find((result) => result.status === 200)?.body?.job;
    expect(firstClaim).toMatchObject({ id: jobId });
    expect(firstClaim).toMatchObject({
      launch: {
        remoteSource: {
          repoUrl: 'https://example.invalid/worker/source.git',
          baseSha: expect.stringMatching(/^[a-f0-9]{40}$/),
          branch: 'o8/cloud-spine',
        },
      },
    });
    expect(JSON.stringify(firstClaim)).not.toContain(repoPath);
    expect(firstClaim?.leaseToken).toBeTruthy();
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'leased',
      claimCount: 1,
      executionAttempts: 0,
    });

    expect(getSqlite().prepare('UPDATE cloud_jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ?')
      .run(Date.now() - 1, jobId, firstClaim?.leaseToken).changes).toBe(1);
    const recoveredPoll = await workerPoll('worker-recovery', 9_999);
    expect(recoveredPoll.status).toBe(200);
    const recoveredClaim = (await recoveredPoll.json() as PollResult['body'])?.job;
    expect(recoveredClaim).toMatchObject({ id: jobId, claimedBy: 'worker-recovery' });
    expect(recoveredClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'leased',
      claimCount: 2,
      leaseRecoveryCount: 1,
      executionAttempts: 0,
    });

    const staleWorker = await workerStream({
      jobId,
      workerId: firstClaim?.claimedBy,
      leaseToken: firstClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'stale completion' },
    });
    expect(staleWorker.status).toBe(409);
    await expect(staleWorker.json()).resolves.toMatchObject({ reason: 'lease_mismatch' });

    recordCloudWorkerPresence({
      teamId: 'team_default', keyId: workerKey.record.id,
      workerId: 'worker-recovery', nowMs: Date.now() - 61_000,
    });
    expect(listConnectedCloudWorkers())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'worker-recovery' })]));
    const rejectedPresence = await workerStream({
      jobId, workerId: 'forged-presence', leaseToken: firstClaim?.leaseToken,
      type: 'heartbeat', payload: { status: 'running' },
    });
    expect(rejectedPresence.status).toBe(409);
    expect(listConnectedCloudWorkers())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'forged-presence' })]));

    const output = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'chunk',
      payload: { text: 'durable worker output' },
    });
    expect(output.status).toBe(200);
    expect(listConnectedCloudWorkers())
      .toEqual(expect.arrayContaining([expect.objectContaining({ workerId: 'worker-recovery' })]));
    const diff = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'diff',
      payload: {
        files: [{
          path: 'src/durable-output.ts',
          status: 'modified',
          additions: 4,
          deletions: 1,
        }],
      },
    });
    expect(diff.status).toBe(200);
    const completed = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'remote work complete' },
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: 'completed' });
    const duplicateCompletion = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'duplicate completion' },
    });
    expect(duplicateCompletion.status).toBe(409);
    expect(getJob('team_default', jobId)?.status).toBe('completed');

    closeDb();
    const transcript = await cloudRuntime.readTranscript(launchBody.surfaceId);
    expect(transcript.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      'durable worker output',
      'remote work complete',
    ]));
    const session = (await cloudRuntime.discoverSessions())
      .find((candidate) => candidate.sessionKey === launchBody.surfaceId);
    expect(session).toMatchObject({
      status: 'completed',
      initialTask: expect.stringContaining('Produce durable remote output.'),
    });
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'completed',
      leaseRecoveryCount: 1,
      executionAttempts: 0,
    });
    await expect(cloudRuntime.getChangedFiles(launchBody.surfaceId)).resolves.toEqual([{
      path: 'src/durable-output.ts',
      status: 'modified',
      additions: 4,
      deletions: 1,
    }]);
  }, 60_000);

  it('parks real failures and resolves steer, abort, and restart-drain races deterministically', async () => {
    process.env.O8_CLOUD_JOB_LEASE_MS = '2000';

    const failedLaunch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Fail within the bounded execution budget.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-failure',
      skipSetup: true,
      packetId: 'packet-cloud-failure-budget',
      clientMutationId: 'cloud-failure-budget-1',
    });
    const failedSurface = (await failedLaunch.json() as { surfaceId: string }).surfaceId;
    const failedJobId = failedSurface.replace(/^cloud:/, '');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const poll = await workerPoll(`failure-worker-${attempt}`);
      expect(poll.status).toBe(200);
      const claim = (await poll.json() as PollResult['body'])?.job;
      const failure = await workerStream({
        jobId: failedJobId,
        workerId: claim?.claimedBy,
        leaseToken: claim?.leaseToken,
        type: 'errored',
        payload: { error: `execution failure ${attempt}` },
      });
      expect(failure.status).toBe(200);
    }
    expect(getJob('team_default', failedJobId)).toMatchObject({
      status: 'parked',
      executionAttempts: 3,
      maxAttempts: 3,
      leaseRecoveryCount: 0,
    });

    const steerLaunch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Reach terminal while a steer is waiting.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-steer',
      skipSetup: true,
      packetId: 'packet-cloud-steer-race',
      clientMutationId: 'cloud-steer-race-1',
    });
    const steerSurface = (await steerLaunch.json() as { surfaceId: string }).surfaceId;
    const steerJobId = steerSurface.replace(/^cloud:/, '');
    const steerPoll = await workerPoll('steer-race-worker');
    const steerClaim = (await steerPoll.json() as PollResult['body'])?.job;
    await expect(cloudRuntime.resume(steerSurface, 'Run this as the next ordered turn.')).resolves.toMatchObject({
      ok: true,
    });
    const steerCompletion = await workerStream({
      jobId: steerJobId,
      workerId: steerClaim?.claimedBy,
      leaseToken: steerClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'first turn finished before steer delivery', commitSha: 'a'.repeat(40) },
    });
    expect(steerCompletion.status).toBe(200);
    const followUp = getLatestSessionJob('team_default', steerJobId);
    expect(followUp).toMatchObject({
      status: 'pending',
      parentJobId: steerJobId,
      sessionId: steerJobId,
      launch: {
        prompt: 'Run this as the next ordered turn.',
        remoteSource: { baseSha: 'a'.repeat(40) },
      },
    });
    expect(listJobControls('team_default', steerJobId)).toEqual([
      expect.objectContaining({ type: 'steer', status: 'follow_up', followUpJobId: followUp?.id }),
    ]);
    const followUpPoll = await workerPoll('follow-up-worker');
    const followUpClaim = (await followUpPoll.json() as PollResult['body'])?.job;
    expect(followUpClaim).toMatchObject({ id: followUp?.id });
    expect((await workerStream({
      jobId: followUp?.id,
      workerId: followUpClaim?.claimedBy,
      leaseToken: followUpClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'follow-up complete' },
    })).status).toBe(200);

    const abortLaunch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Wait for a durable abort.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-abort',
      skipSetup: true,
      packetId: 'packet-cloud-abort-race',
      clientMutationId: 'cloud-abort-race-1',
    });
    const abortSurface = (await abortLaunch.json() as { surfaceId: string }).surfaceId;
    const abortJobId = abortSurface.replace(/^cloud:/, '');
    const abortPoll = await workerPoll('abort-worker');
    const abortClaim = (await abortPoll.json() as PollResult['body'])?.job;
    await expect(cloudRuntime.resume(abortSurface, 'Continue after cancellation.')).resolves.toMatchObject({ ok: true });
    await expect(cloudRuntime.interrupt(abortSurface)).resolves.toMatchObject({ ok: true });
    const deliveredAbort = await workerControl(abortClaim!);
    expect(deliveredAbort.status).toBe(200);
    const abortControl = (await deliveredAbort.json() as {
      control: { id: string; deliveryToken: string; type: string };
    }).control;
    expect(abortControl.type).toBe('abort');
    expect((await workerControl(abortClaim!)).status).toBe(204);
    const abortAck = await acknowledgeControl(abortClaim!, abortControl);
    expect(abortAck.status).toBe(200);
    expect(getJob('team_default', abortJobId)).toMatchObject({ status: 'cancelled' });
    const abortFollowUp = getLatestSessionJob('team_default', abortJobId);
    expect(abortFollowUp).toMatchObject({ status: 'pending', parentJobId: abortJobId });
    const abortFollowUpPoll = await workerPoll('abort-follow-up-worker');
    const abortFollowUpClaim = (await abortFollowUpPoll.json() as PollResult['body'])?.job;
    expect(abortFollowUpClaim?.id).toBe(abortFollowUp?.id);
    expect((await workerStream({
      jobId: abortFollowUpClaim?.id,
      workerId: abortFollowUpClaim?.claimedBy,
      leaseToken: abortFollowUpClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'follow-up after cancellation' },
    })).status).toBe(200);

    const drainLaunch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Release this lease during restart.',
      cwd: repoPath,
      repoPath,
      branchName: 'o8/cloud-drain',
      skipSetup: true,
      packetId: 'packet-cloud-drain',
      clientMutationId: 'cloud-drain-1',
    });
    const drainJobId = (await drainLaunch.json() as { surfaceId: string }).surfaceId.replace(/^cloud:/, '');
    expect((await workerPoll('drain-worker')).status).toBe(200);
    const beginDrain = await drainRoute.POST(new NextRequest('http://localhost/api/panel/cloud-jobs/drain', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    await expect(beginDrain.json()).resolves.toMatchObject({
      drain: { draining: true, activeLeases: 1 },
    });
    const finalizeDrain = await drainRoute.POST(new NextRequest('http://localhost/api/panel/cloud-jobs/drain', {
      method: 'POST',
      body: JSON.stringify({ finalize: true }),
    }));
    await expect(finalizeDrain.json()).resolves.toMatchObject({
      drain: { draining: true, activeLeases: 0, pendingJobs: 1 },
    });
    expect(getJob('team_default', drainJobId)).toMatchObject({
      status: 'pending',
      executionAttempts: 0,
      leaseRecoveryCount: 0,
    });

    const restartedWorker = new PollChild('post-restart-worker');
    await restartedWorker.waitFor('READY');
    restartedWorker.child.stdin.end('go\n');
    const restartedClaim = await restartedWorker.result();
    await restartedWorker.waitForExit();
    expect(restartedClaim).toMatchObject({ status: 200, body: { job: { id: drainJobId } } });
    expect(getJobDrainStatus('team_default').draining).toBe(false);
    expect((await workerStream({
      jobId: drainJobId,
      workerId: restartedClaim.body?.job?.claimedBy,
      leaseToken: restartedClaim.body?.job?.leaseToken,
      type: 'completed',
      payload: { result: 'drained lease recovered' },
    })).status).toBe(200);
  }, 60_000);

  it('runs the built worker through HTTP, remote clone, Codex stdin, push, and persisted restart', async () => {
    process.env.O8_CLOUD_JOB_LEASE_MS = '30000';
    execFileSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: process.cwd() });
    const fakeBin = join(dataDir, 'fake-bin');
    const workerHome = join(dataDir, 'external-worker');
    const codexPidFile = join(dataDir, 'abort-codex.pid');
    mkdirSync(fakeBin, { recursive: true });
    const fakeCodex = join(fakeBin, 'codex');
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (process.env.O8_CLOUD_WORKER_KEY) process.exit(17);",
      "if (!process.argv.includes('-')) process.exit(18);",
      "let prompt = '';",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (prompt.includes('abort remote task')) {",
      "    fs.writeFileSync(process.env.O8_TEST_CODEX_PID_FILE, String(process.pid));",
      "    process.on('SIGTERM', () => {});",
      "    setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      "  fs.writeFileSync('worker-proof.txt', prompt.includes('second remote task') ? 'second run\\n' : 'first run\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Remote agent completed the task.' } }) + '\\n');",
      '});',
    ].join('\n'));
    chmodSync(fakeCodex, 0o755);
    const bridge = await startWorkerHttpBridge();
    const workerEnvironment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      O8_CLOUD_WORKER_KEY: workerKey.plaintext,
      O8_TEST_CODEX_PID_FILE: codexPidFile,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${realpathSync.native(bareRemotePath)}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://example.invalid/worker/source.git',
    };
    const startWorker = () => spawn(process.execPath, [
      join(process.cwd(), 'dist/worker/o8-worker.mjs'),
      '--o8-url', bridge.url,
      '--workspace-dir', workerHome,
      '--poll-interval-ms', '1000',
      '--control-poll-interval-ms', '1000',
    ], { env: workerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let worker = startWorker();
    let workerOutput = '';
    worker.stdout.on('data', (chunk: Buffer) => { workerOutput += chunk.toString(); });
    worker.stderr.on('data', (chunk: Buffer) => { workerOutput += chunk.toString(); });
    try {
      for (const [index, packetId, prompt] of [
        [1, 'packet-cloud-worker-process', 'first remote task'],
        [2, 'packet-cloud-worker-restart', 'second remote task'],
      ] as const) {
        const launch = await runtimeLaunch({
          runtime: 'cloud', prompt, cwd: repoPath, repoPath,
          branchName: `o8/worker-process-${index}`,
          packetId,
          skipSetup: true,
          clientMutationId: `cloud-worker-process-${index}`,
        });
        expect(launch.status).toBe(200);
        const surfaceId = (await launch.json() as { surfaceId: string }).surfaceId;
        const jobId = surfaceId.replace(/^cloud:/, '');
        await waitForWorkerJob(jobId);
        await expect(cloudRuntime.readTranscript(surfaceId)).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ text: 'Remote agent completed the task.' })]),
        );
        await expect(cloudRuntime.getChangedFiles(surfaceId)).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'worker-proof.txt', status: 'added' })]),
        );
        const pushed = execFileSync('git', [
          '--git-dir', bareRemotePath, 'show', `refs/heads/o8/worker-process-${index}:worker-proof.txt`,
        ], { encoding: 'utf8' });
        expect(pushed).toBe(index === 1 ? 'first run\n' : 'second run\n');
        const pushedSha = execFileSync('git', [
          '--git-dir', bareRemotePath, 'rev-parse', `refs/heads/o8/worker-process-${index}`,
        ], { encoding: 'utf8' }).trim();
        closeDb();
        expect(readJobEvents('team_default', jobId, 0)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'completed', payload: expect.objectContaining({ commitSha: pushedSha }) }),
          expect.objectContaining({ type: 'chunk', payload: expect.objectContaining({
            checkout: expect.objectContaining({ cacheHit: index === 2, durationMs: expect.any(Number) }),
          }) }),
        ]));
        if (index === 1) {
          worker.kill('SIGKILL');
          await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
          worker = startWorker();
          worker.stdout.on('data', (chunk: Buffer) => { workerOutput += chunk.toString(); });
          worker.stderr.on('data', (chunk: Buffer) => { workerOutput += chunk.toString(); });
        }
      }
      const rejectHook = join(bareRemotePath, 'hooks', 'pre-receive');
      writeFileSync(rejectHook, [
        '#!/bin/sh',
        'while read old new ref; do',
        '  if [ "$ref" = "refs/heads/o8/worker-process-reject" ]; then exit 1; fi',
        'done',
        'exit 0',
      ].join('\n'));
      chmodSync(rejectHook, 0o755);
      const rejectedLaunch = await runtimeLaunch({
        runtime: 'cloud', prompt: 'push rejected task', cwd: repoPath, repoPath,
        branchName: 'o8/worker-process-reject', packetId: 'packet-cloud-worker-reject-push',
        skipSetup: true, clientMutationId: 'cloud-worker-process-reject-push',
      });
      expect(rejectedLaunch.status).toBe(200);
      const rejectedId = (await rejectedLaunch.json() as { surfaceId: string }).surfaceId.replace(/^cloud:/, '');
      const rejectDeadline = Date.now() + 20_000;
      while (getJob('team_default', rejectedId)?.status !== 'parked' && Date.now() < rejectDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(getJob('team_default', rejectedId)).toMatchObject({
        status: 'parked',
        executionAttempts: 3,
        lastError: expect.stringContaining('git push failed'),
      });
      expect(readJobEvents('team_default', rejectedId, 0).some(event => event.type === 'completed')).toBe(false);
      expect(() => execFileSync('git', [
        '--git-dir', bareRemotePath, 'rev-parse', '--verify', 'refs/heads/o8/worker-process-reject',
      ], { stdio: 'pipe' })).toThrow();

      const abortLaunch = await runtimeLaunch({
        runtime: 'cloud', prompt: 'abort remote task', cwd: repoPath, repoPath,
        branchName: 'o8/worker-process-abort', packetId: 'packet-cloud-worker-abort',
        skipSetup: true, clientMutationId: 'cloud-worker-process-abort',
      });
      expect(abortLaunch.status).toBe(200);
      const abortJobId = (await abortLaunch.json() as { surfaceId: string }).surfaceId.replace(/^cloud:/, '');
      const startDeadline = Date.now() + 10_000;
      while (!existsSync(codexPidFile) && Date.now() < startDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(codexPidFile)).toBe(true);
      const codexPid = Number(readFileSync(codexPidFile, 'utf8'));
      await expect(cloudRuntime.interrupt(`cloud:${abortJobId}`)).resolves.toMatchObject({ ok: true });
      const cancelDeadline = Date.now() + 15_000;
      while (getJob('team_default', abortJobId)?.status !== 'cancelled' && Date.now() < cancelDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(getJob('team_default', abortJobId)?.status).toBe('cancelled');
      expect(() => process.kill(codexPid, 0)).toThrow();
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; worker stderr: ${workerOutput}`);
    } finally {
      worker.kill('SIGKILL');
      await bridge.close();
    }
  }, 60_000);
});
