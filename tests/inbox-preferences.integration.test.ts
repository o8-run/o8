import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, PATCH, DELETE } from '@/app/api/v2/chat-history/route';
import { GET as historyList } from '@/app/api/v2/chat-history/list/route';
import { GET as inventory } from '@/app/api/runtime/inventory/route';
import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { createLane } from '@/lib/lane/registry';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// Only external runtime discovery is fixed. Routes, SQLite, histories and restart are real.
const fixture = vi.hoisted(() => ({ agents: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: fixture.agents }) }));
const ids: string[] = [];
const prefix = `thoughts-preferences-${process.pid}`;
const patch = (body: Record<string, unknown>, query = '') => PATCH(new NextRequest(`http://localhost/api/v2/chat-history${query}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
async function seed(suffix: string, pinned = false) {
  const tabId = `${prefix}-${suffix}`;
  ids.push(tabId);
  expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', body: JSON.stringify({ tabId, pinned, repoPath: process.cwd(), messages: [
      { id: 'u', role: 'user', content: 'Question', timestamp: 100 },
      { id: 'a', role: 'assistant', content: 'Done', timestamp: 101 },
    ] }),
  }))).status).toBe(200);
  return tabId;
}
async function row(tabId: string) {
  const body = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
  return body.conversations.find((candidate: { tabId: string }) => candidate.tabId === tabId);
}
afterAll(async () => {
  fixture.agents = [];
  for (const tabId of ids) await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
});

describe('durable inbox pin, order and auto-settle preferences through existing routes', () => {
  it('round-trips pin/order/opt-out through a fresh listing process without changing transcript activity', async () => {
    const tabId = await seed('restart');
    const before = await row(tabId);
    expect(before.inboxSubject).toMatchObject({ kind: 'conversation', id: tabId });
    for (const field of ['pinnedAt', 'pinOrderKey', 'activeOrderKey', 'autoSettleDisabledAt']) expect(before).not.toHaveProperty(field);
    const mutate = (inboxAction: string, inboxRevision: number, extra = {}) => patch({ tabId, inboxAction, inboxRevision, ...extra });
    const pinnedResponse = await mutate('pin', 0, { orderKey: 'n' });
    expect(pinnedResponse.status).toBe(200);
    const pinned = await pinnedResponse.json();
    expect(pinned).toMatchObject({ ok: true, inboxRevision: 1, pinnedAt: expect.any(String), pinOrderKey: 'n',
      activeOrderKey: null, autoSettleDisabledAt: null, settledOverride: null });
    const repeated = await mutate('pin', 1, { orderKey: 'z' });
    expect(await repeated.json()).toMatchObject({ inboxRevision: 1, pinnedAt: pinned.pinnedAt, pinOrderKey: 'n' });
    expect((await mutate('pin-reorder', 1, { orderKey: 't' })).status).toBe(200);
    expect((await mutate('auto-settle', 2, { enabled: false })).status).toBe(200);
    const disabled = await row(tabId);
    expect(disabled).toMatchObject({ pinned: true, pinnedAt: pinned.pinnedAt, pinOrderKey: 't',
      inboxRevision: 3, autoSettleDisabledAt: expect.any(String), modifiedAt: before.modifiedAt, savedAt: before.savedAt });
    expect((await mutate('auto-settle', 3, { enabled: false })).status).toBe(200);
    expect(await row(tabId)).toMatchObject({ inboxRevision: 3, autoSettleDisabledAt: disabled.autoSettleDisabledAt });
    const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
      const { NextRequest } = await import('next/server.js');
      const route = (await import('./src/app/api/v2/chat-history/list/route.ts')).default;
      const response = await route.GET(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'));
      const row = (await response.json()).conversations.find(row => row.tabId === process.env.B02_TAB_ID);
      console.log('B02_RESTART=' + JSON.stringify(row));
      process.exit(row?.pinnedAt && row?.pinOrderKey === 't' && row?.autoSettleDisabledAt && row?.inboxRevision === 3 ? 0 : 1);
    `], { cwd: process.cwd(), env: { ...process.env, B02_TAB_ID: tabId }, stdio: 'pipe', timeout: 90_000, killSignal: 'SIGKILL' });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    expect((await once(child, 'exit'))[0], output).toBe(0);
    expect(output).toContain('B02_RESTART=');
    const history = JSON.parse(readFileSync(join(getDataDir(), 'chat-history', `${tabId}.json`), 'utf8'));
    expect(history.messages.map((message: { id: string }) => message.id)).toEqual(['u', 'a']);
    expect((await mutate('unpin', 3)).status).toBe(200);
    expect((await mutate('active-reorder', 4, { orderKey: 'g' })).status).toBe(200);
    expect((await mutate('auto-settle', 5, { enabled: true })).status).toBe(200);
    expect(await row(tabId)).toMatchObject({ pinned: false, activeOrderKey: 'g', inboxRevision: 6, modifiedAt: before.modifiedAt });
    for (const field of ['pinnedAt', 'pinOrderKey', 'autoSettleDisabledAt']) expect(await row(tabId)).not.toHaveProperty(field);
  }, 120_000);

  it('rejects stale and invalid writes, archived rows and unknown/workspace-mismatched subjects', async () => {
    const tabId = await seed('guards');
    const mutate = (inboxAction: string, inboxRevision: number, extra = {}) => patch({ tabId, inboxAction, inboxRevision, ...extra });
    expect((await mutate('pin-reorder', 0, { orderKey: 'n' })).status).toBe(409);
    const results = await Promise.all([mutate('pin', 0, { orderKey: 'g' }), mutate('pin', 0, { orderKey: 't' })]);
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await mutate('active-reorder', 1, { orderKey: 'n' })).status).toBe(409);
    expect((await mutate('pin-reorder', 0, { orderKey: 'z' })).status).toBe(409);
    for (const orderKey of ['', 'a', 'na', 'UPPER', 'n!']) expect((await mutate('pin-reorder', 1, { orderKey })).status).toBe(400);
    expect((await patch({ tabId, inboxAction: 'pin' })).status).toBe(400);
    expect((await mutate('auto-settle', 1, { enabled: 'false' })).status).toBe(400);
    expect((await patch({ tabId, inboxAction: 'pin', inboxRevision: 1 }, '?workspace=/wrong')).status).toBe(404);
    const missing = `${prefix}-missing`;
    const count = getSqlite().prepare("SELECT count(*) AS n FROM app_state WHERE key LIKE 'inbox:subject:%'").get();
    expect((await patch({ tabId: missing, inboxAction: 'pin', inboxRevision: 0 })).status).toBe(404);
    expect(existsSync(join(getDataDir(), 'chat-history', `${missing}.json`))).toBe(false);
    expect(getSqlite().prepare("SELECT count(*) AS n FROM app_state WHERE key LIKE 'inbox:subject:%'").get()).toEqual(count);
    expect((await patch({ tabId, archivedAt: new Date().toISOString() })).status).toBe(200);
    expect((await mutate('unpin', 1)).status).toBe(409);
  });

  it('pin promotes settled rows and settle clears both order keys', async () => {
    const tabId = await seed('transitions');
    expect((await patch({ tabId, inboxAction: 'settle' })).status).toBe(200);
    const settled = await row(tabId);
    expect((await patch({ tabId, inboxAction: 'pin', inboxRevision: settled.inboxRevision, orderKey: 'n' })).status).toBe(200);
    let current = await row(tabId);
    expect(current).toMatchObject({ settledOverride: 'active', pinnedAt: expect.any(String) });
    expect(current).not.toHaveProperty('settledAt');
    expect((await patch({ tabId, inboxAction: 'settle' })).status).toBe(200);
    current = await row(tabId);
    expect(current.pinned).toBe(false);
    expect(current).not.toHaveProperty('pinnedAt');
    expect(current).not.toHaveProperty('pinOrderKey');
    expect((await patch({ tabId, inboxAction: 'active-reorder', inboxRevision: current.inboxRevision, orderKey: 'n' })).status).toBe(409);
    expect((await patch({ tabId, inboxAction: 'unsettle' })).status).toBe(200);
    current = await row(tabId);
    expect((await patch({ tabId, inboxAction: 'active-reorder', inboxRevision: current.inboxRevision, orderKey: 'g' })).status).toBe(200);
    expect((await patch({ tabId, inboxAction: 'settle' })).status).toBe(200);
    expect(await row(tabId)).not.toHaveProperty('activeOrderKey');
    const finalSettled = await row(tabId);
    // A stale legacy transcript save cannot recreate a pin or reset settlement time.
    expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST', body: JSON.stringify({ tabId, pinned: true, messages: [] }),
    }))).status).toBe(200);
    expect(await row(tabId)).toMatchObject({ pinned: false, settledAt: finalSettled.settledAt });
    const repeated = await patch({ tabId, inboxAction: 'settle' });
    expect(await repeated.json()).toMatchObject({ settledAt: finalSettled.settledAt, inboxRevision: finalSettled.inboxRevision });
  });

  it('migrates existing boolean pins deterministically and honors the legacy pin PATCH', async () => {
    const tabId = await seed('legacy', true);
    const before = await row(tabId);
    expect(before).toMatchObject({ pinned: true, pinnedAt: '1970-01-01T00:00:00.000Z' });
    expect(await row(tabId)).toMatchObject({ pinnedAt: before.pinnedAt });
    const active = await patch({ tabId, inboxAction: 'unsettle' });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ pinnedAt: before.pinnedAt, pinOrderKey: null, settledOverride: 'active' });
    expect((await patch({ tabId, pinned: false })).status).toBe(200);
    expect(await row(tabId)).toMatchObject({ pinned: false });
    expect(await row(tabId)).not.toHaveProperty('pinnedAt');
    expect((await patch({ tabId, pinned: true })).status).toBe(200);
    expect(await row(tabId)).toMatchObject({ pinned: true, pinnedAt: expect.any(String) });
  });

  it('projects the parent preference for child workers and rejects independent organization', async () => {
    const tabId = await seed('parent');
    const sessionKey = `codex:b02-child-${process.pid}`;
    const packetId = `b02-child-${process.pid}`;
    createLane({ repoPath: process.cwd(), branch: 'b02-child', runtime: 'codex', sessionKey, packetId, baseCommit: 'a'.repeat(40) });
    const packet = { id: packetId, referenceLabel: 'inline-1', title: 'Child', summary: 'Child',
      workspaceTargetPath: process.cwd(), branchTarget: 'b02-child', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
      status: 'idle', review: null, orchestratorThreadId: tabId } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'b02-parent', repoPath: process.cwd(), packets: [packet] });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle' }];
    expect((await patch({ tabId, inboxAction: 'pin', inboxRevision: 0, orderKey: 'n' })).status).toBe(200);
    const parent = await row(tabId);
    const listing = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(listing.agents[0]).toMatchObject({ inboxSubject: parent.inboxSubject, parentInboxSubject: parent.inboxSubject,
      pinnedAt: parent.pinnedAt, pinOrderKey: 'n', inboxRevision: parent.inboxRevision });
    expect((await patch({ sessionKey, inboxAction: 'unpin', inboxRevision: parent.inboxRevision })).status).toBe(409);
  });

  it('persists standalone runtime preferences and has zero steady-poll writes', async () => {
    const sessionKey = `codex:b02-${process.pid}`;
    createLane({ repoPath: process.cwd(), branch: 'b02-fixture', runtime: 'codex', sessionKey, baseCommit: 'a'.repeat(40) });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } } }];
    const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
    const initial = await read();
    expect(initial.inboxSubject).toMatchObject({ kind: 'runtime', id: sessionKey });
    for (const field of ['pinnedAt', 'pinOrderKey', 'activeOrderKey', 'autoSettleDisabledAt']) expect(initial).not.toHaveProperty(field);
    expect((await patch({ sessionKey, inboxAction: 'pin', inboxRevision: initial.inboxRevision ?? 0, orderKey: 'n' })).status).toBe(200);
    let current = await read();
    expect((await patch({ sessionKey, inboxAction: 'auto-settle', inboxRevision: current.inboxRevision, enabled: false })).status).toBe(200);
    current = await read();
    expect(current).toMatchObject({ inboxSubject: { kind: 'runtime', id: sessionKey }, pinnedAt: expect.any(String),
      pinOrderKey: 'n', autoSettleDisabledAt: expect.any(String) });
    const prototype = Object.getPrototypeOf(getSqlite().prepare('SELECT 1'));
    const original = prototype.run;
    let writes = 0;
    const trace = vi.spyOn(prototype, 'run').mockImplementation(function(this: { source: string }, ...parameters: unknown[]) {
      if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app_state\b/i.test(this.source)) writes++;
      return original.apply(this, parameters);
    });
    try {
      for (let i = 0; i < 3; i++) expect(await read()).toEqual(current);
      expect(writes).toBe(0);
    } finally { trace.mockRestore(); }
    expect((await patch({ sessionKey, inboxAction: 'unsettle' })).status).toBe(200);
    const active = await read();
    expect(active.settledOverride).toBe('active');
    fixture.agents[0].runtimeSurface = { lifecycle: { lastRunStartedAt: new Date(Date.now() + 1_000).toISOString() } };
    const advanced = await read();
    expect(advanced).toMatchObject({ pinnedAt: current.pinnedAt, autoSettleDisabledAt: current.autoSettleDisabledAt });
    expect(advanced).not.toHaveProperty('settledOverride');
    expect((await patch({ sessionKey, inboxAction: 'unpin', inboxRevision: active.inboxRevision })).status).toBe(409);
  });
});
