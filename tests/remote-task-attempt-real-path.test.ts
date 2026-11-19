import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })),
  purgeOrphanedSpecDirectives: vi.fn(async () => 0),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-remote-evidence-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLOUD_JOB_LEASE_MS = '500';
const repoPath = join(dataDir, 'repo');
const runtimeRoute = await import('@/app/api/runtime/launch/route');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const { addRepo } = await import('@/lib/repos/registry');
const { createCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob, cancelJob, readJobEvents } = await import('@/lib/cloud/job-queue');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const key = createCloudWorkerKey({ teamId: 'team_default', label: 'evidence fixture' });
function git(...args: string[]) { return execFileSync('git', args, { stdio: 'pipe' }).toString().trim(); }
const published = await import('@/lib/cloud/published-base');
vi.spyOn(published, 'resolvePublishedCloudBase').mockImplementation(async () => git('-C', repoPath, 'rev-parse', 'HEAD'));
beforeAll(async () => {
  mkdirSync(repoPath);
  git('init', '-b', 'main', repoPath);
  git('-C', repoPath, 'config', 'user.name', 'Test');
  git('-C', repoPath, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repoPath, 'README.md'), 'Fixture\n');
  git('-C', repoPath, 'add', '.');
  git('-C', repoPath, 'commit', '-m', 'test: fixture');
  git('-C', repoPath, 'remote', 'add', 'origin', 'https://example.invalid/fixture.git');
  await addRepo(repoPath);
  const state = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({ ...state, repoPath, runtime: 'codex', packets: [{
    id: 'packet-cloud-evidence', referenceLabel: 'packet-cloud-evidence', title: 'Remote evidence fixture', summary: 'Evidence fixture',
    status: 'draft', queueState: 'queued', releaseState: 'pending', blockedReason: null,
    lane: null, review: null, runtime: 'cloud', workspaceTargetPath: repoPath,
    branchTarget: 'o8/cloud-evidence', dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
    lastEventAt: new Date().toISOString(), lastEventLabel: 'created', recoveryCount: 0, typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  }] } as Parameters<typeof writeOrchestratorControlPlaneState>[0]);
});
afterAll(() => { vi.restoreAllMocks(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });
function runtimeLaunch(body: unknown) {
  return runtimeRoute.POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST', headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
function workerPoll(workerId: string, cursor: number) {
  return pollRoute.GET(new NextRequest(`http://localhost/api/cloud/worker-poll?waitMs=0&workerId=${workerId}&cursor=${cursor}`, { headers: { Authorization: `Bearer ${key.plaintext}` } }));
}
function workerStream(body: unknown) {
  return streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', { method: 'POST', headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}
// Retained from the retired evidence-route fixture: these assertions belong
// to the surviving worker-poll/worker-stream and durable job-event owners.
describe('remote attempt persistence through authenticated worker routes', () => {
  it('persists claim output across reopen and rejects the previous worker after reclaim', async () => {
    const previousLease = process.env.O8_CLOUD_JOB_LEASE_MS;
    let evidenceJobId: string | null = null;
    process.env.O8_CLOUD_JOB_LEASE_MS = '500';
    try {
      const launch = await runtimeLaunch({
        runtime: 'cloud', prompt: 'Produce disposable fixture output.', cwd: repoPath, repoPath,
        branchName: 'o8/cloud-evidence', packetId: 'packet-cloud-evidence', skipSetup: true,
        clientMutationId: 'cloud-evidence-1',
      });
      expect(launch.status).toBe(200);
      const launched = await launch.json() as { surfaceId: string };
      const jobId = launched.surfaceId.replace(/^cloud:/, '');
      evidenceJobId = jobId;
      const cursor = getJob('team_default', jobId)!.cursor;
      const firstPoll = await workerPoll('evidence-first', cursor);
      expect(firstPoll.status).toBe(200);
      const firstJob = (await firstPoll.json() as { job: { id: string; claimedBy: string; leaseToken: string } }).job;
      expect(firstJob.id).toBe(jobId);
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'chunk', payload: { text: 'first attempt log' } })).status).toBe(200);
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'diff', payload: { files: [{ path: 'first.txt', status: 'added', additions: 1, deletions: 0 }] } })).status).toBe(200);
      closeDb();
      const first = readJobEvents('team_default', jobId);
      expect(first).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'chunk', payload: { text: 'first attempt log' } }),
        expect.objectContaining({ type: 'diff', payload: { files: [{ path: 'first.txt', status: 'added', additions: 1, deletions: 0 }] } }),
      ]));
      expect(getJob('team_default', jobId)?.claimCount).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 550));
      const secondPoll = await workerPoll('evidence-second', cursor);
      expect(secondPoll.status).toBe(200);
      const secondJob = (await secondPoll.json() as { job: { id: string; claimedBy: string; leaseToken: string } }).job;
      expect(secondJob.id).toBe(jobId);
      expect(getJob('team_default', jobId)?.claimCount).toBe(2);
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'chunk', payload: { text: 'stale worker' } })).status).toBe(409);
      expect((await workerStream({ jobId, workerId: secondJob.claimedBy, leaseToken: secondJob.leaseToken, type: 'chunk', payload: { text: 'second attempt log' } })).status).toBe(200);
      closeDb();
      const latest = readJobEvents('team_default', jobId);
      expect(latest.filter(event => event.type === 'claimed')).toHaveLength(2);
      expect(latest).toContainEqual(expect.objectContaining({ type: 'chunk', payload: { text: 'second attempt log' } }));
      expect(latest).not.toContainEqual(expect.objectContaining({ payload: { text: 'stale worker' } }));
    } finally {
      if (evidenceJobId) cancelJob('team_default', evidenceJobId);
      if (previousLease === undefined) delete process.env.O8_CLOUD_JOB_LEASE_MS;
      else process.env.O8_CLOUD_JOB_LEASE_MS = previousLease;
    }
  });
});
