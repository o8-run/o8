import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { LaneReviewScreenshotReference } from '@/lib/lane/review-screenshot';

const h = vi.hoisted(() => ({ perform: vi.fn() }));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  performRuntimeAction: h.perform,
}));

const dataDir = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-preview-data-')));
const repoPath = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-preview-repo-')));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb } = await import('@/lib/db');
const { GET: serveImage } = await import('@/app/api/panel/serve-image/route');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { createLane, deleteLane, getLaneEvents } = await import('@/lib/lane/registry');
const { waitForPreviewReady } = await import('@/lib/orchestrator/ui-loop-preview');
const { steerWarmUiLoop } = await import('@/lib/orchestrator/ui-loop');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const createdLaneIds: string[] = [];
let previewUrl = '';
let previewRequests = 0;
let previewStatus: (request: number) => number = () => 200;
let browserProbeResults: boolean[] = [];
let browserGrabCalls = 0;
const realFetch = globalThis.fetch;

function packetFixture(id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: 'P1',
    title: 'Edit the selected element',
    summary: 'Apply the Design Mode element edit.',
    origin: 'design-mode',
    workspaceTargetPath: repoPath,
    branchTarget: `feat/${id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'running',
    archivedAt: null,
    review: null,
    lane: null,
    issue: { number: 1906, url: 'https://example.invalid/issues/1906' },
  };
}

function createTestLane(packetId = `packet-${createdLaneIds.length + 1}`) {
  const lane = createLane({
    repoPath,
    branch: `feat/${packetId}`,
    runtime: 'codex',
    packetId,
    sessionKey: `test-owned:${packetId}`,
    label: `warm-${packetId}`,
  });
  createdLaneIds.push(lane.id);
  return lane;
}

function persistPacket(packet: OrchestratorPacket): void {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-ui-loop-preview-real-path',
    repoPath,
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  previewRequests = 0;
  previewStatus = () => 200;
  browserProbeResults = [];
  browserGrabCalls = 0;
  h.perform.mockReset();
  h.perform.mockResolvedValue({
    ok: true,
    action: 'steer',
    surfaceId: 'test-owned',
    sessionKey: 'test-owned',
    runtime: 'codex',
    status: 'completed',
    note: 'steered',
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.includes('/api/browser/agent')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { verb?: string };
      if (body.verb === 'probe') {
        const ok = browserProbeResults.shift() ?? true;
        return Response.json(ok ? { ok: true, found: '#save' } : { ok: false, pending: true });
      }
      if (body.verb === 'grab') {
        browserGrabCalls += 1;
        return Response.json({
          ok: true,
          element: {
            screenshot: `data:image/png;base64,${Buffer.from('after-frame').toString('base64')}`,
            boundingRect: { top: 20, left: 40, width: 120, height: 36 },
          },
        });
      }
    }
    return realFetch(input, init);
  }));
  persistPacket(packetFixture('packet-empty'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const laneId of createdLaneIds.splice(0)) deleteLane(laneId);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

const server = createServer((request, response) => {
  request.resume();
  previewRequests += 1;
  response.statusCode = previewStatus(previewRequests);
  response.end(response.statusCode === 200 ? 'ready' : 'warming');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Preview fixture did not bind an ephemeral port.');
previewUrl = `http://127.0.0.1:${address.port}/preview`;

describe('UI-loop preview real path', () => {
  it('waits through three 503 responses and records deterministic 250 ms check offsets', async () => {
    const lane = createTestLane();
    previewStatus = (request) => request <= 3 ? 503 : 200;

    const result = await waitForPreviewReady({
      packetId: lane.packetId!,
      laneId: lane.id,
      url: previewUrl,
      timeoutMs: 2_000,
    });

    expect(result.state).toBe('ready');
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((check) => check.elapsedMs)).toEqual([0, 250, 500, 750]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(750);
  });

  it('times out at one second, records failure, and never requests an AFTER capture', async () => {
    const lane = createTestLane();
    previewStatus = () => 503;

    const result = await waitForPreviewReady({
      packetId: lane.packetId!,
      laneId: lane.id,
      url: previewUrl,
      timeoutMs: 1_000,
    });

    expect(result.state).toBe('timed_out');
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'ui_loop_preview_failed', payload: expect.objectContaining({ state: 'timed_out' }) }),
    ]));
    expect(browserGrabCalls).toBe(0);
  });

  it('returns no_preview without polling', async () => {
    const lane = createTestLane();

    await expect(waitForPreviewReady({ packetId: lane.packetId!, laneId: lane.id }))
      .resolves.toMatchObject({ state: 'no_preview', checks: [] });
    expect(previewRequests).toBe(0);
  });

  it('reuses the embedded browser wait handler until the selector probe becomes ready', async () => {
    const lane = createTestLane();
    browserProbeResults = [false, false, true];

    const result = await waitForPreviewReady({
      packetId: lane.packetId!,
      laneId: lane.id,
      url: previewUrl,
      readySelector: '#save',
      readyText: 'Save',
      timeoutMs: 2_000,
    });

    expect(result.state).toBe('ready');
    expect(result.checks.at(-1)).toMatchObject({ kind: 'browser', ok: true });
    expect(browserProbeResults).toEqual([]);
  });

  it('persists private BEFORE and AFTER screenshot references while refusing opaque reads', async () => {
    const packet = packetFixture('packet-proof');
    persistPacket(packet);
    const lane = createTestLane(packet.id);
    recordLaneEvent(lane.id, 'workspace_manifest_applied', 'system', { preview: previewUrl, state: 'completed' });

    await expect(steerWarmUiLoop({
      repoPath,
      text: 'Edit the selected browser element.\nElement: <button#save>\nSelector: #save',
      previewImageDataUri: `data:image/png;base64,${Buffer.from('before-frame').toString('base64')}`,
      readySelector: '#save',
      readyText: 'Save',
      element: '<button#save>',
      elementRect: { top: 20, left: 40, width: 120, height: 36 },
    })).resolves.toMatchObject({ kind: 'steered' });
    recordLaneEvent(lane.id, 'agent_report', 'system', { event: 'done' });

    let proof: ReturnType<typeof getLaneEvents>[number] | undefined;
    await vi.waitFor(() => {
      proof = getLaneEvents(lane.id, 100).find((event) => event.verb === 'ui_loop_proof');
      expect(proof).toBeDefined();
    }, { timeout: 5_000 });

    const before = proof!.payload.before as LaneReviewScreenshotReference;
    const after = proof!.payload.after as LaneReviewScreenshotReference;
    expect(before.path).not.toBe(after.path);
    for (const reference of [before, after]) {
      expect(statSync(reference.path).mode & 0o777).toBe(0o600);
      const response = await serveImage(new Request(
        `http://localhost/api/panel/serve-image?path=${encodeURIComponent(reference.path)}`,
      ));
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ code: 'binary_preview_refused', redaction: { version: 1 } });
      expect(statSync(reference.path).size).toBeGreaterThan(0);
    }
    expect(proof!.payload).toMatchObject({
      proofId: expect.stringMatching(new RegExp(`^${lane.id}:\\d+$`)),
      previewUrl,
      elapsedMs: expect.any(Number),
    });
    expect(browserGrabCalls).toBe(1);
  });
});
