import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

it.each([
  ['prNumber', 11, 22],
  ['threadId', 'thread-packet-a', 'thread-packet-b'],
  ['repoPath', join(directory, 'packet-a'), join(directory, 'packet-b')],
])('checks artifact %s against the caller packet', async (field, own, other) => {
  const body = { packetId: 'packet-a', bytesBase64: 'eA==', kind: 'video', mimeType: 'video/mp4' };
  expect((await call('/api/panel/artifacts', { ...body, [field]: other })).status).toBe(403);
  const accepted = await call('/api/panel/artifacts', { ...body, [field]: own });
  expect(accepted.status).toBe(200);
  const { artifactId } = await accepted.json();
  const { listArtifacts } = await import('@/lib/artifacts/store');
  expect(listArtifacts({ packetId: 'packet-a' }).find(a => a.id === artifactId)).toMatchObject({ [field]: own });
  expect((await call('/api/panel/artifacts', { ...body, [field]: other }, operator)).status).toBe(200);
});
it('accepts an artifact for the packet\'s own PR after its opened note is replaced', async () => {
  const body = { packetId: 'packet-merged', bytesBase64: 'eA==', kind: 'video', mimeType: 'video/mp4' };
  expect((await call('/api/panel/artifacts', { ...body, prNumber: 33 }, seeded.mergedWorker)).status).toBe(200);
  expect((await call('/api/panel/artifacts', { ...body, prNumber: 11 }, seeded.mergedWorker)).status).toBe(403);
  // Mirroring posts outside o8 and still requires the recorded opened note.
  expect((await call('/api/panel/artifacts/mirror', { packetId: 'packet-merged', repoSlug: 'fixture/own', prNumber: 33 }, seeded.mergedWorker)).status).toBe(403);
});
it('stores the canonical managed run packet ID', async () => {
  const accepted = await call('/api/panel/managed-runs', { id: 'trimfixture', session: 'cortex-run-trimfixture',
    command: 'fixture', cwd: directory, packetId: ' packet-a ', laneId: seeded.own });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ run: { packetId: 'packet-a' } });
  const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
  expect(findManagedRun('trimfixture')?.packetId).toBe('packet-a');
});

const checkout = join(directory, 'checkout');
const foreignRepo = join(directory, 'checkout-other');
mkdirSync(checkout);
mkdirSync(foreignRepo);
symlinkSync(foreignRepo, join(checkout, 'outside'));
symlinkSync(join(foreignRepo, 'missing'), join(checkout, 'dangling'));
it.each([
  ['foreign', foreignRepo, false, 403],
  ['foreignlatest', foreignRepo, true, 403],
  ['repo', directory, false, 403],
  ['symlink', join(checkout, 'outside', 'pending'), false, 403],
  ['dangling', join(checkout, 'dangling'), false, 403],
  ['symlinkparent', checkout + '/outside/../x', false, 403],
  ['relative', '.', false, 403],
  ['parent', checkout + '/../checkout-other', false, 403],
  ['own', join(checkout, 'pending', 'child'), false, 200],
  ['latest', checkout, true, 200],
  ['operator', foreignRepo, false, 200],
])('keeps the managed run directory in its checkout: %s', async (name, cwd, omitLane, status) => {
  const { updateLane } = await import('@/lib/lane/registry');
  const { listAutomationSourceEvents } = await import('@/lib/automations/source-events');
  updateLane(seeded.own, { worktreePath: name === 'relative' ? process.cwd() : checkout });
  const id = 'directory' + name;
  try {
    const response = await call('/api/panel/managed-runs', {
      id, session: 'cortex-run-' + id, command: 'fixture', cwd, packetId: 'packet-a',
      ...(omitLane ? {} : { laneId: seeded.own }),
    }, name === 'operator' ? operator : seeded.worker);
    const events = listAutomationSourceEvents({ sourceKind: 'managed_run', afterSequence: 0, repoPath: foreignRepo });
    expect(events.filter(event => event.sourceId === id)).toEqual([]);
    expect(response.status).toBe(status);
    const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
    if (status === 403) {
      expect(findManagedRun(id)).toBeNull();
      expect(listAutomationSourceEvents({ sourceKind: 'managed_run', afterSequence: 0, sourceId: id })).toEqual([]);
    }
    else expect(await response.json()).toMatchObject({ run: { cwd, laneId: seeded.own } });
  } finally {
    updateLane(seeded.own, { worktreePath: null });
  }
});

it('accepts the checkout with different letter case on a case-insensitive volume', async (context) => {
  const variant = checkout.slice(0, -'checkout'.length) + 'CHECKOUT';
  if (!existsSync(variant)) {
    context.skip('Filesystem is case-sensitive; a case variant names a different directory.');
    return;
  }
  const { updateLane } = await import('@/lib/lane/registry');
  updateLane(seeded.own, { worktreePath: checkout });
  try {
    const response = await call('/api/panel/managed-runs', { id: 'casefixture', session: 'cortex-run-casefixture',
      command: 'fixture', cwd: variant, packetId: 'packet-a', laneId: seeded.own });
    expect(response.status).toBe(200);
  } finally {
    updateLane(seeded.own, { worktreePath: null });
  }
});

it('registers and finishes an operator packet run without a lane and records both events', async () => {
  const id = 'operatornolane';
  const response = await call('/api/panel/managed-runs', { id, session: 'cortex-run-' + id,
    command: 'fixture', cwd: foreignRepo, packetId: 'packet-a' }, operator);
  expect(response.status).toBe(200);
  expect((await call('/api/panel/managed-runs', { action: 'finish', id, exitCode: 0 }, operator)).status).toBe(200);
  const { listAutomationSourceEvents } = await import('@/lib/automations/source-events');
  expect(listAutomationSourceEvents({ sourceKind: 'managed_run', sourceId: id, afterSequence: 0 }))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'started', repoPath: null }),
      expect.objectContaining({ eventType: 'exit_clean', repoPath: null }),
    ]));
});

it('finishes a deleted-lane run and records its event without throwing', async () => {
  const { createLane, deleteLane } = await import('@/lib/lane/registry');
  const lane = createLane({ repoPath: directory, branch: 'deleted', runtime: 'codex', packetId: 'packet-a' });
  const id = 'deletedlanefixture';
  expect((await call('/api/panel/managed-runs', { id, session: 'cortex-run-' + id, command: 'fixture',
    cwd: directory, packetId: 'packet-a', laneId: lane.id }, operator)).status).toBe(200);
  deleteLane(lane.id);
  const response = await call('/api/panel/managed-runs', { action: 'finish', id, exitCode: 0 }, operator);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ run: { status: 'finished' } });
  const { listAutomationSourceEvents } = await import('@/lib/automations/source-events');
  expect(listAutomationSourceEvents({ sourceKind: 'managed_run', sourceId: id, afterSequence: 0 }))
    .toContainEqual(expect.objectContaining({ eventType: 'exit_clean', repoPath: null }));
});

it('does not attribute a pre-existing worker run without a lane to its foreign cwd', async () => {
  const { registerManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
  const { listAutomationSourceEvents } = await import('@/lib/automations/source-events');
  const id = 'legacyforeign';
  registerManagedRun({ id, session: 'cortex-run-' + id, command: 'fixture', cwd: foreignRepo,
    packetId: 'packet-a', laneId: null, mode: 'stream', startedAt: new Date().toISOString(), status: 'running' });
  const response = await call('/api/panel/managed-runs', { action: 'output', id, outputChunk: 'fixture', outputSequence: 1 });
  expect(response.status).toBe(200);
  expect(listAutomationSourceEvents({ sourceKind: 'managed_run', sourceId: id, afterSequence: 0 }))
    .toContainEqual(expect.objectContaining({ eventType: 'output', repoPath: null }));
  expect(listAutomationSourceEvents({ sourceKind: 'managed_run', sourceId: id, afterSequence: 0, repoPath: foreignRepo })).toEqual([]);
});
