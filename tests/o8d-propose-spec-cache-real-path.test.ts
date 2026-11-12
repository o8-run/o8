import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
const io = vi.hoisted(() => ({ writeFails: false, readFails: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (io.writeFails && String(args[0]).includes('snapshot-')) throw new Error('private filesystem detail');
      return fs.writeFileSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (io.readFails && String(args[0]).includes('snapshot-')) throw new Error('private filesystem detail');
      return fs.readFileSync(...args);
    },
  };
});
const realtime = vi.hoisted(() => ({ publish: vi.fn(async () => true) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: realtime.publish }));
const review = vi.hoisted(() => ({ read: vi.fn(async () => null) }));
vi.mock('@/lib/review/workspace', () => ({ getWorkspaceReviewSnapshot: review.read, invalidateReviewSnapshotCache: vi.fn() }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [], events: [], meta: {} }), invalidateRuntimeInventoryCache: vi.fn() }));
vi.mock('@/lib/browser/inventory', () => ({ getBrowserInventorySnapshot: async () => ({ surfaces: [] }) }));
vi.mock('@/lib/runtime/ide-llm-chat-registry', () => ({ listIdeLlmChatSessions: () => [] }));
let server: Awaited<ReturnType<typeof startParityReference>>;
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, startupTimeoutMs: 120_000 });
  await server.stopNext();
  vi.stubEnv('O8_DATA_DIR', server.directory);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', server.directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(server.directory, 'cortex-ide.db'));
  execFileSync(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    const { withLockedState } = require('./src/lib/orchestrator/control-plane.ts');
    withLockedState(state => { state.packets.push({ id: 'cache-packet', title: 'Cache packet', status: 'running' }); return state; });
  `], { env: { ...process.env, WS_TOKEN: server.token } });
}, 180_000);
afterAll(async () => { vi.unstubAllEnvs(); await server?.stop(); });
it('refreshes warm Next inbox and command-center caches immediately after a native spec proposal', async () => {
  const inbox = await import('@/app/api/mobile/inbox/route');
  const { getCommandCenterSnapshot } = await import('@/lib/command-center/snapshot');
  const request = () => new NextRequest('http://127.0.0.1/api/mobile/inbox');
  const initial = await inbox.GET(request());
  expect(initial.status).toBe(200);
  expect(JSON.stringify(await initial.json())).not.toContain('Cache coherence test');
  await getCommandCenterSnapshot();
  const reads = review.read.mock.calls.length;
  await getCommandCenterSnapshot();
  expect(review.read).toHaveBeenCalledTimes(reads);
  const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  const proposed = await fetch(`${origin}/api/orchestrator/propose-spec`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ packetId: 'cache-packet', proposedSpec: '# Updated spec', rationale: 'Cache coherence test' }) });
  expect(proposed.status, await proposed.text()).toBe(200);
  const updated = await inbox.GET(request());
  expect(updated.status).toBe(200);
  expect(JSON.stringify(await updated.json())).toContain('Cache coherence test');
  await getCommandCenterSnapshot();
  expect(review.read.mock.calls.length).toBeGreaterThan(reads);
}, 120_000);

it('keeps a spec proposal successful and clears local caches when generation writes fail', async () => {
  const { GET } = await import('@/app/api/mobile/inbox/route');
  const { getCommandCenterSnapshot } = await import('@/lib/command-center/snapshot');
  const { POST } = await import('@/lib/orchestrator/http/propose-spec');
  const { listApprovals } = await import('@/lib/approvals/store');
  const request = () => new NextRequest('http://127.0.0.1/api/mobile/inbox');
  expect((await GET(request())).status).toBe(200);
  await getCommandCenterSnapshot();
  const reads = review.read.mock.calls.length;
  const before = listApprovals({ status: 'pending' }).length;
  const published = realtime.publish.mock.calls.length;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  io.writeFails = true;
  try {
    const response = await POST(new NextRequest('http://127.0.0.1/api/orchestrator/propose-spec', {
      method: 'POST', headers: { host: '127.0.0.1' },
      body: JSON.stringify({ packetId: 'cache-packet', proposedSpec: '# Local update', rationale: 'Failed generation write test' }),
    }));
    expect(response.status, await response.text()).toBe(200);
    expect(listApprovals({ status: 'pending' })).toHaveLength(before + 1);
    expect(listApprovals({ status: 'pending' }).filter(approval => approval.description === 'Failed generation write test')).toHaveLength(1);
    expect(realtime.publish).toHaveBeenCalledTimes(published + 1);
    expect(JSON.stringify(await (await GET(request())).json())).toContain('Failed generation write test');
    await getCommandCenterSnapshot();
    expect(review.read.mock.calls.length).toBeGreaterThan(reads);
    expect(warning.mock.calls).toEqual([
      ['[snapshot-cache] Could not publish cache invalidation.'],
      ['[snapshot-cache] Could not publish cache invalidation.'],
    ]);
  } finally { io.writeFails = false; warning.mockRestore(); }
}, 120_000);

it('treats generation read errors as changed and keeps serving snapshots', async () => {
  const { GET } = await import('@/app/api/mobile/inbox/route');
  const { getCommandCenterSnapshot } = await import('@/lib/command-center/snapshot');
  io.readFails = true;
  try {
    for (let index = 0; index < 2; index += 1) {
      expect((await GET(new NextRequest('http://127.0.0.1/api/mobile/inbox'))).status).toBe(200);
      const reads = review.read.mock.calls.length;
      await getCommandCenterSnapshot();
      expect(review.read.mock.calls.length).toBeGreaterThan(reads);
    }
  } finally { io.readFails = false; }
}, 120_000);
