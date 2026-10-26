import type { Lane } from '@/lib/lane/types';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const [root, output] = process.argv.slice(2);
  const data = join(root, 'data');
  const repo = join(root, 'repo');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'feature-flags.json'), JSON.stringify({ remoteRuntime: true }));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/remote-fixture.git'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=o8', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: initialize remote effort fixture'], { cwd: repo });
  process.env.O8_DATA_DIR = data;
  process.env.CORTEX_IDE_DATA_DIR = data;
  delete process.env.O8_ENABLE_REMOTE_RUNTIME;
  const { NextRequest } = await import('next/server');
  const { getRuntime } = await import('@/lib/runtimes');
  const { getRemoteRuntimeFlagSync } = await import('@/lib/worker/feature-flags');
  const { createToken } = await import('@/lib/worker/tokens');
  const { createLane, listLanes } = await import('@/lib/lane/registry');
  const { getSqlite, closeDb } = await import('@/lib/db');
  const { POST } = await import('@/app/api/runtime/launch/route');
  const { CustomerWorkerTransport } = await import('@/lib/runtimes/remote/customer-worker-transport');
  createToken({ label: 'Remote effort fixture', scope: 'global', maxWorkers: 2 });
  const sqlite = getSqlite();
  const snapshot = () => ({
    runs: sqlite.prepare('SELECT count(*) AS n FROM worker_runs').get(),
    events: sqlite.prepare('SELECT count(*) AS n FROM worker_events').get(),
    lanes: JSON.stringify(listLanes()),
    receipts: sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%idempotency%'").all()
      .map(row => ({ table: (row as {name:string}).name,
        count: sqlite.prepare(`SELECT count(*) AS n FROM "${(row as {name:string}).name}"`).get() })),
  });
  const remote = getRuntime('remote-customer');
  if (!remote) throw new Error('Persisted startup gate did not register the remote runtime');
  const cases = [];
  let correctionStatus: number | undefined;
  for (const effort of [undefined, 'adaptive', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const lane = createLane({ repoPath: repo, branch: 'main', runtime: 'remote-customer' as Lane['runtime'], label: 'Remote effort fixture' });
    const id = `remote-effort-${effort ?? 'omitted'}`;
    const request = { runtime: 'remote-customer', cwd: repo, prompt: 'fixture request', model: 'remote/model-fixture',
      effort, existingLaneId: lane.id, clientMutationId: id, isolate: false, skipSetup: true };
    const before = snapshot();
    const response = await POST(new NextRequest('http://localhost/api/runtime/launch', { method: 'POST', body: JSON.stringify(request) }));
    const body = await response.json();
    const after = snapshot();
    const rows = sqlite.prepare("SELECT payload_json FROM worker_events WHERE event_type='launch' ORDER BY id DESC LIMIT 1").all() as Array<{payload_json:string}>;
    cases.push({ effort: effort ?? 'omitted', status: response.status, body, before, after,
      captured: response.status === 200 ? JSON.parse(rows[0]?.payload_json ?? 'null') : null });
    if (effort === 'high') {
      const correction = await POST(new NextRequest('http://localhost/api/runtime/launch', { method: 'POST',
        body: JSON.stringify({ ...request, effort: 'adaptive' }) }));
      correctionStatus = correction.status;
    }
  }
  // Exercise adapter and queue boundaries directly as well as the public route.
  const directLane = createLane({ repoPath: repo, branch: 'main', runtime: 'remote-customer' as Lane['runtime'], label: 'Remote direct fixture' });
  const directBefore = snapshot();
  const direct = await remote.launch({ cwd: repo, prompt: 'direct fixture', effort: 'high', laneId: directLane.id });
  const directAfter = snapshot();
  const queueBefore = snapshot();
  let queueError = '';
  try { await new CustomerWorkerTransport().sendLaunch({ runId: 'direct-queue-effort', laneId: directLane.id,
    repoUrl: 'https://example.invalid/remote-fixture.git', baseRef: 'main', remoteBranch: 'fixture', packetPrompt: 'fixture', effort: 'max' }); }
  catch (error) { queueError = error instanceof Error ? error.message : String(error); }
  const queueAfter = snapshot();
  const unknownBefore = snapshot();
  const unknown = await POST(new NextRequest('http://localhost/api/runtime/launch', { method: 'POST',
    body: JSON.stringify({ runtime: 'fixture-unverified-runtime', effort: 'high', cwd: repo, prompt: 'fixture', clientMutationId: 'unverified-runtime' }) }));
  const unknownAfter = snapshot();
  writeFileSync(output, JSON.stringify({ flag: getRemoteRuntimeFlagSync(), cases, direct, directBefore, directAfter,
    queueBefore, queueAfter, queueError, correctionStatus, unknownStatus: unknown.status, unknownBefore, unknownAfter }));
  closeDb();
}
main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
