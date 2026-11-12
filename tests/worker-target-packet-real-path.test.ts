import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { seedWorkerTargets } from './fixtures/worker-targets';

const directory = mkdtempSync(join(tmpdir(), 'o8-worker-targets-'));
Object.assign(process.env, { O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory, O8_NEXT_O8D: '0' });
const operator = 'worker-target-operator-fixture';
writeFileSync(join(directory, 'ws-token'), operator);
const seeded = await seedWorkerTargets(directory);
const { panelGateMiddleware } = await import('@/middleware');
const task = await import('@/app/api/tasks/[taskId]/route');
const artifacts = await import('@/app/api/panel/artifacts/route');
const runs = await import('@/app/api/panel/managed-runs/route');
const mirror = await import('@/app/api/panel/artifacts/mirror/route');
async function call(path: string, body?: unknown, token = seeded.worker) {
  const request = new NextRequest(`http://localhost:3001${path}`, { method: body ? 'POST' : 'GET',
    headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'x-o8-client-addr': '127.0.0.1', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const gate = panelGateMiddleware(request);
  if (gate.headers.get('x-middleware-next') !== '1') return gate;
  if (!body) return task.GET(request, { params: Promise.resolve({ taskId: path.split('/').pop()! }) });
  return (path.endsWith('/mirror') ? mirror : path.endsWith('/managed-runs') ? runs : artifacts).POST(request);
}
afterAll(async () => { (await import('@/lib/db')).closeDb(); rmSync(directory, { recursive: true, force: true }); });
it('checks the task against the caller packet', async () => {
  expect((await call('/api/tasks/packet-b')).status).toBe(403);
  expect((await call('/api/tasks/packet-a')).status).toBe(200);
  expect((await call('/api/tasks/packet-b', undefined, operator)).status).toBe(200);
}, 120_000);
it('checks every artifact association against the caller packet', async () => {
  const body = { packetId: 'packet-a', bytesBase64: 'eA==', mimeType: 'video/mp4', kind: 'video' };
  expect((await call('/api/panel/artifacts', { ...body, laneId: seeded.other })).status).toBe(403);
  expect((await call('/api/panel/artifacts', { ...body, packetId: 'packet-b', laneId: seeded.own })).status).toBe(403);
  expect((await call('/api/panel/artifacts', { ...body, laneId: 'missing' })).status).toBe(403);
  const accepted = await call('/api/panel/artifacts', { ...body, laneId: seeded.own });
  expect(accepted.status).toBe(200);
  const { listArtifacts } = await import('@/lib/artifacts/store');
  expect(listArtifacts({ laneId: seeded.other })).toEqual([]);
  expect(listArtifacts({ laneId: seeded.own })).toHaveLength(1);
  expect((await call('/api/panel/artifacts', { ...body, packetId: 'packet-b', laneId: seeded.other }, operator)).status).toBe(200);
});
it('checks the managed run lane against the caller packet', async () => {
  const body = { id: 'targetfixture', session: 'cortex-run-targetfixture', command: 'fixture', cwd: directory, packetId: 'packet-a' };
  expect((await call('/api/panel/managed-runs', { ...body, laneId: seeded.other })).status).toBe(403);
  expect((await call('/api/panel/managed-runs', { ...body, laneId: 'missing' })).status).toBe(403);
  const accepted = await call('/api/panel/managed-runs', { ...body, laneId: seeded.own });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ run: { packetId: 'packet-a', laneId: seeded.own } });
  const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
  expect(findManagedRun(body.id)?.laneId).toBe(seeded.own);
});
it('checks the recorded packet PR destination', async () => {
  const body = { packetId: 'packet-a', repoSlug: 'fixture/own', prNumber: 11 };
  expect((await call('/api/panel/artifacts/mirror', { ...body, repoSlug: 'fixture/other', prNumber: 22 })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, repoSlug: 'fixture/other' })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, prNumber: 22 })).status).toBe(403);
  expect((await call('/api/panel/artifacts/mirror', { ...body, packetId: 'packet-no-pr' }, seeded.noPr)).status).toBe(403);
  const response = await call('/api/panel/artifacts/mirror', body);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ mirrored: false, reason: 'no proof screenshots for this packet/lane' });
  expect((await call('/api/panel/artifacts/mirror', { ...body, packetId: 'packet-b' }, operator)).status).toBe(422);
});
