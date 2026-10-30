import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { inboxSubject } from '@/lib/inbox/store';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, PATCH, GET, DELETE } from '@/app/api/v2/chat-history/route';
import { GET as list } from '@/app/api/mobile/orchestrator/threads/route';
import { GET as historyList } from '@/app/api/v2/chat-history/list/route';
import { GET as inventory } from '@/app/api/runtime/inventory/route';
import { createLane, setLaneStatus } from '@/lib/lane/registry';
import { createApproval } from '@/lib/approvals/store';
import { getSqlite } from '@/lib/db';
import { enqueueComposerSend } from '@/lib/orchestrator/composer-queue';

// Runtime discovery is an external provider boundary. The lanes, approvals,
// transcript, mutation, persisted metadata and both listing routes are real.
const fixture = vi.hoisted(() => {
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const claudeHome = `${process.env.CORTEX_IDE_DATA_DIR}/inbox-claude`;
  process.env.CLAUDE_HOME = claudeHome;
  return { previousClaudeHome, claudeHome, realTranscript: false, agents: [] as Array<Record<string, unknown>>,
    transcript: [] as Array<{ id: string; role: 'user'; text: string; timestamp: Date; activityAt?: Date }> };
});
vi.mock('@/lib/runtimes', async original => {
  const actual = await original<typeof import('@/lib/runtimes')>();
  return { ...actual, getRuntime: (id: Parameters<typeof actual.getRuntime>[0]) => {
    const runtime = actual.getRuntime(id);
    return fixture.realTranscript ? runtime : runtime ? { ...runtime, readTranscript: async () => fixture.transcript } : undefined;
  } };
});
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: fixture.agents }) }));
const prefix = `thoughts-inbox-${process.pid}`;
const ids: string[] = [];
const request = (body: Record<string, unknown>, query = '') => new NextRequest(`http://localhost/api/v2/chat-history${query}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const mutate = (tabId: string, inboxAction: string) => PATCH(request({ tabId, inboxAction }));
async function seed(suffix: string, timestamp = 100) {
  const tabId = `${prefix}-${suffix}`;
  ids.push(tabId);
  expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId, repoPath: process.cwd(), messages: [
      { id: 'u', role: 'user', content: 'Hello', timestamp },
      { id: 'a', role: 'assistant', content: 'Finished', timestamp: timestamp + 1 },
    ] }),
  }))).status).toBe(200);
  return tabId;
}
async function listed(tabId: string) {
  const data = await (await list(new NextRequest('http://localhost/api/mobile/orchestrator/threads?limit=500'))).json();
  return data.threads.find((thread: { id: string }) => thread.id === tabId);
}
afterAll(async () => {
  if (fixture.previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = fixture.previousClaudeHome;
  for (const tabId of ids) await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
});

describe('inbox settlement through operator mutation and native listings', () => {
  it('round-trips settle/unsettle and repeat timestamps without archiving or dropping messages', async () => {
    const tabId = await seed('roundtrip');
    expect(await listed(tabId)).toMatchObject({ settledOverride: null, settledAt: null, unsettledAt: null });
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    const settled = await listed(tabId);
    const archiveRows = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
    expect(archiveRows.conversations.find((row: { tabId: string }) => row.tabId === tabId)).toMatchObject({ settledOverride: 'settled', settledAt: settled.settledAt });
    expect(settled).toMatchObject({ inboxSubject: { kind: 'conversation', id: tabId }, settledOverride: 'settled', settledAt: expect.any(String), unsettledAt: null });
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    expect(await listed(tabId)).toEqual(settled);
    expect((await mutate(tabId, 'unsettle')).status).toBe(200);
    const active = await listed(tabId);
    expect(active).toMatchObject({ settledOverride: 'active', settledAt: null, unsettledAt: expect.any(String) });
    await mutate(tabId, 'unsettle');
    expect(await listed(tabId)).toEqual(active);
    const pending = createApproval({ source: 'test', runtime: 'llm-chat', agent: 'fixture', sessionKey: `llm-chat:${tabId}`,
      title: 'Chat approval', description: 'Pending', summary: 'Pending', risk: 'low' });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(pending.id);
    const saved = await (await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`))).json();
    expect(saved.messages.map((m: { id: string }) => m.id)).toEqual(['u', 'a']);
    expect(saved.archivedAt).toBeNull();
  });

  it('omits null inbox fields from GET rows while preserving capability and the full PATCH shape', async () => {
    const tabId = await seed('compact-get');
    const readHistory = async () => {
      const body = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
      return body.conversations.find((row: { tabId: string }) => row.tabId === tabId);
    };
    const empty = await readHistory();
    expect(empty.inboxSubject).toMatchObject({ kind: 'conversation', id: tabId });
    for (const field of ['settledOverride', 'settledAt', 'unsettledAt', 'parentInboxSubject']) {
      expect(empty).not.toHaveProperty(field);
    }
    const settled = await (await mutate(tabId, 'settle')).json();
    expect(settled).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'settled',
      settledAt: expect.any(String), unsettledAt: null });
    const settledRow = await readHistory();
    expect(settledRow).toMatchObject({ inboxSubject: empty.inboxSubject, settledOverride: 'settled', settledAt: settled.settledAt });
    expect(settledRow).not.toHaveProperty('unsettledAt');
    expect(settledRow).not.toHaveProperty('parentInboxSubject');
    const active = await (await mutate(tabId, 'unsettle')).json();
    expect(active).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'active',
      settledAt: null, unsettledAt: expect.any(String) });
    const activeRow = await readHistory();
    expect(activeRow).toMatchObject({ settledOverride: 'active', unsettledAt: active.unsettledAt });
    expect(activeRow).not.toHaveProperty('settledAt');

    const previousAgents = fixture.agents;
    fixture.agents = [{ sessionKey: `codex:compact-${process.pid}`, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } } }];
    try {
      const body = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
      expect(body.agents[0].inboxSubject).toMatchObject({ kind: 'runtime', id: fixture.agents[0].sessionKey });
      for (const field of ['settledOverride', 'settledAt', 'unsettledAt', 'parentInboxSubject']) {
        expect(body.agents[0]).not.toHaveProperty(field);
      }
      const patch = await (await PATCH(request({ sessionKey: fixture.agents[0].sessionKey, inboxAction: 'unsettle' }))).json();
      expect(patch).toMatchObject({ ok: true, parentInboxSubject: null, settledOverride: 'active', settledAt: null,
        unsettledAt: expect.any(String) });
    } finally { fixture.agents = previousAgents; }
  });

  it.each([-1, 1])('rejects queued-turn grace with clock skew direction %s', async direction => {
    const tabId = await seed(`grace-${direction}`, Date.now() + direction * 60_000);
    // An unadopted user send, rather than an assistant-completed turn.
    await POST(new NextRequest('http://localhost/api/v2/chat-history', { method: 'POST', body: JSON.stringify({ tabId, replace: true, messages: [{ id: 'u', role: 'user', content: 'queued', timestamp: Date.now() + direction * 60_000 }] }) }));
    expect((await mutate(tabId, 'settle')).status).toBe(409);
  });

  it('rejects an actual durable queued send', async () => {
    const tabId = await seed('queued');
    enqueueComposerSend({ id: `${prefix}-queue`, repoPath: process.cwd(), threadId: tabId, intent: 'send-next', payload: {
      text: 'next', wireMessage: 'next', images: [], routing: { backend: 'codex', model: 'gpt-5', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false },
    } });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
  });

  it('persists a standalone runtime subject and rejects running and pending approval', async () => {
    const sessionKey = `codex:inbox-${process.pid}`;
    const lane = createLane({ repoPath: process.cwd(), branch: 'fixture', runtime: 'codex', sessionKey, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle', approvalStatus: 'none' }];
    const patch = () => PATCH(request({ sessionKey, inboxAction: 'settle' }));
    setLaneStatus(lane.id, 'running');
    expect((await patch()).status).toBe(409);
    setLaneStatus(lane.id, 'idle');
    fixture.agents[0].status = 'reviewing';
    expect((await patch()).status).toBe(200);
    fixture.agents[0].status = 'idle';
    const snapshot = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(snapshot.agents[0]).toMatchObject({ inboxSubject: { kind: 'runtime', id: sessionKey }, settledOverride: 'settled', settledAt: expect.any(String) });
    expect(snapshot.agents[0]).not.toHaveProperty('parentInboxSubject');
    createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey, title: 'Approval', description: 'Pending', summary: 'Pending', risk: 'low' });
    expect((await patch()).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE session_key = ?').run(sessionKey);
    expect((await PATCH(request({ sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
    fixture.agents[0].lastActivityAt = Date.now() + 1_000;
    const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
    expect((await read()).settledOverride).toBe('active');
    fixture.transcript = [{ id: 'runtime-run', role: 'user', text: 'Actual new run', timestamp: new Date(Date.now() + 1), activityAt: new Date(Date.now() + 1) }];
    expect(await read()).not.toHaveProperty('settledOverride');
    expect((await patch()).status).toBe(409); // Recent runtime user message not yet adopted.
    fixture.transcript = [];
  });

  it('reads lanes once per poll and writes no app_state rows after adopting unchanged activity', async () => {
    fixture.agents = Array.from({ length: 4 }, (_, index) => ({
      sessionKey: `codex:poll-${process.pid}-${index}`, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } },
    }));
    const poll = () => inventory(new NextRequest('http://localhost/api/runtime/inventory'));
    expect((await poll()).status).toBe(200); // Adopt the initial observations.
    expect((await PATCH(request({ sessionKey: fixture.agents[0].sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
    const statementPrototype = Object.getPrototypeOf(getSqlite().prepare('SELECT 1')) as {
      all: (...parameters: unknown[]) => unknown[];
      run: (...parameters: unknown[]) => unknown;
    };
    const all = statementPrototype.all;
    let laneReads = 0;
    const trace = vi.spyOn(statementPrototype, 'all').mockImplementation(function(this: { source: string }, ...parameters: unknown[]) {
      if (/\bFROM\s+["`]?lanes\b/i.test(this.source)) laneReads += 1;
      return all.apply(this, parameters);
    });
    const run = statementPrototype.run;
    let stateWrites = 0;
    const writes = vi.spyOn(statementPrototype, 'run').mockImplementation(function(this: { source: string }, ...parameters: unknown[]) {
      if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?app_state\b/i.test(this.source)) stateWrites += 1;
      return run.apply(this, parameters);
    });
    const transaction = vi.spyOn(getSqlite(), 'transaction');
    try {
      for (let index = 0; index < 3; index++) {
        const snapshot = await (await poll()).json();
        expect(snapshot.agents).toHaveLength(4);
        expect(snapshot.agents[0].settledOverride).toBe('active');
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(stateWrites).toBe(0);
      expect(laneReads).toBe(1); // First poll refreshes after PATCH; subsequent revision checks reuse it.
      fixture.agents[0].runtimeSurface = { lifecycle: { lastRunStartedAt: new Date(Date.now() + 1_000).toISOString() } };
      const advanced = await (await poll()).json();
      expect(advanced.agents[0]).not.toHaveProperty('settledOverride');
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(stateWrites).toBe(1);
    } finally {
      trace.mockRestore();
      writes.mockRestore();
      transaction.mockRestore();
      fixture.agents = [];
    }
  });

  it('shares canonical workspace identities across reads and mutations until the bounded TTL expires', async () => {
    const root = join(getDataDir(), 'inbox-workspace-cache');
    const first = join(root, 'first');
    const second = join(root, 'second');
    const link = join(root, 'link');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    symlinkSync(first, link);
    const tabId = await seed('workspace-cache');
    const file = join(getDataDir(), 'chat-history', `${tabId}.json`);
    const history = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...history, repoPath: link }));
    const native = vi.spyOn(realpathSync, 'native');
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    const read = async () => {
      const snapshot = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
      return snapshot.conversations.find((row: { tabId: string }) => row.tabId === tabId);
    };
    try {
      clock.mockReturnValue(now);
      expect((await mutate(tabId, 'unsettle')).status).toBe(200);
      unlinkSync(link);
      symlinkSync(second, link);
      expect(await read()).toMatchObject({ inboxSubject: { workspace: first }, settledOverride: 'active' });
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(1);
      clock.mockReturnValue(now + 30_001);
      const moved = await read();
      expect(moved).toMatchObject({ inboxSubject: { workspace: second } });
      expect(moved).not.toHaveProperty('settledOverride');
      expect((await mutate(tabId, 'unsettle')).status).toBe(200);
      expect(await read()).toMatchObject({ inboxSubject: { workspace: second }, settledOverride: 'active' });
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(2);
      // Eviction forces resolution again even before the TTL expires.
      for (let index = 0; index < 256; index++) inboxSubject('runtime', 'cache-bound', join(root, `offline-${index}`));
      expect(inboxSubject('conversation', tabId, link).workspace).toBe(second);
      expect(native.mock.calls.filter(([path]) => path === link)).toHaveLength(3);
    } finally {
      native.mockRestore();
      clock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates lane identities after both external commits and local writes', async () => {
    const sessionKey = `codex:lane-cache-${process.pid}`;
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle',
      runtimeSurface: { lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' } } }];
    const lane = createLane({ repoPath: process.cwd(), branch: 'cache-invalidation', runtime: 'codex', sessionKey, baseCommit: 'a'.repeat(40) });
    const otherWorkspace = join(getDataDir(), 'inbox-external-workspace');
    mkdirSync(otherWorkspace, { recursive: true });
    const external = new Database(getSqlite().name);
    const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
    try {
      expect((await read()).inboxSubject.workspace).toBe(realpathSync.native(process.cwd()));
      external.prepare('UPDATE lanes SET repo_path = ? WHERE id = ?').run(otherWorkspace, lane.id);
      expect((await read()).inboxSubject.workspace).toBe(otherWorkspace);
      getSqlite().prepare('UPDATE lanes SET repo_path = ? WHERE id = ?').run(process.cwd(), lane.id);
      expect((await read()).inboxSubject.workspace).toBe(realpathSync.native(process.cwd()));
    } finally {
      external.close();
      fixture.agents = [];
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it('represents packet workers under the parent and blocks independent settlement', async () => {
    const tabId = await seed('parent');
    const sessionKey = `codex:child-${process.pid}`;
    const packetId = `inbox-child-${process.pid}`;
    const lane = createLane({ repoPath: process.cwd(), branch: 'fixture-child', runtime: 'codex', sessionKey, packetId, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const packet = { id: packetId, referenceLabel: 'inline-1', title: 'Child', summary: 'Child',
      workspaceTargetPath: process.cwd(), branchTarget: 'fixture-child', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
      status: 'idle', review: null, orchestratorThreadId: tabId } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'inbox-parent', repoPath: process.cwd(), packets: [packet] });
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'idle', approvalStatus: 'none' }];
    expect((await PATCH(request({ sessionKey, inboxAction: 'settle' }))).status).toBe(409);
    setLaneStatus(lane.id, 'running');
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    setLaneStatus(lane.id, 'idle');
    const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey: 'review:synthetic',
      title: 'Packet approval', description: 'Pending', summary: 'Pending', risk: 'low', metadata: { Packet: packetId, Lane: lane.id } });
    expect((await mutate(tabId, 'settle')).status).toBe(409);
    getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(approval.id);
    expect((await mutate(tabId, 'settle')).status).toBe(200);
    const snapshot = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(snapshot.agents[0]).toMatchObject({ inboxSubject: { kind: 'conversation', id: tabId },
      parentInboxSubject: { kind: 'conversation', id: tabId }, settledOverride: 'settled' });
    expect(readFileSync(join(getDataDir(), 'chat-history', `${tabId}.json`), 'utf8')).toContain('Finished');
    setLaneStatus(lane.id, 'archived');
    const standalone = createLane({ repoPath: process.cwd(), branch: 'new-standalone', runtime: 'codex', sessionKey, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const reused = await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json();
    expect(reused.agents[0]).toMatchObject({ inboxSubject: { kind: 'runtime', id: sessionKey } });
    expect(reused.agents[0]).not.toHaveProperty('parentInboxSubject');
    setLaneStatus(standalone.id, 'running');
    fixture.agents[0].status = 'running';
    expect((await mutate(tabId, 'settle')).status).toBe(200);
  });

  it('waits for a concurrent transcript append and reloads settlement in a fresh process', async () => {
    const tabId = await seed('race');
    const marker = join(getDataDir(), `${tabId}-locked`);
    const child = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
      import { writeFileSync } from 'node:fs';
      const store = (await import('./src/lib/llm/chat-history-store.ts')).default;
      store.withCanonicalChatHistoryLock(process.env.B01_TAB_ID, () => {
        writeFileSync(process.env.B01_MARKER, 'locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        const record = store.readPersistedLlmChat(process.env.B01_TAB_ID).history;
        store.persistCanonicalChatHistoryRecord(process.env.B01_TAB_ID, { ...record,
          messages: [...record.messages, { id: 'race', role: 'assistant', content: 'Concurrent reply', timestamp: 102 }] });
      });
    `], { cwd: process.cwd(), env: { ...process.env, B01_TAB_ID: tabId, B01_MARKER: marker }, stdio: 'pipe' });
    let childOutput = '';
    child.stderr?.on('data', chunk => { childOutput += String(chunk); });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 45_000;
    try {
      while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(marker), childOutput).toBe(true);
      expect((await mutate(tabId, 'settle')).status).toBe(200);
      expect((await exited)[0]).toBe(0);
      const saved = await (await GET(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`))).json();
      expect(saved.messages.map((m: { id: string }) => m.id)).toEqual(['u', 'a', 'race']);
      const reload = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '--eval', `
        const store = (await import('./src/lib/inbox/store.ts')).default;
        const state = store.inboxProjection(store.inboxSubject('conversation', process.env.B01_TAB_ID, process.cwd()));
        if (state.settledOverride !== 'settled' || !state.settledAt) process.exitCode = 1;
      `], { cwd: process.cwd(), env: { ...process.env, B01_TAB_ID: tabId }, stdio: 'pipe' });
      expect((await once(reload, 'exit'))[0]).toBe(0);
      expect(await listed(tabId)).toMatchObject({ settledOverride: 'settled', settledAt: expect.any(String) });
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
      rmSync(marker, { force: true });
    }
  }, 120_000);

  it('ignores inferred provider timestamps and clears only on authentic runtime activity', async () => {
    const sessionKey = 'claude-code:inbox-authentic';
    const project = join(fixture.claudeHome, 'projects', 'inbox-project');
    mkdirSync(project, { recursive: true });
    const file = join(project, 'inbox-authentic.jsonl');
    const historical = { type: 'user', uuid: 'historical', message: { content: 'Historical message' } };
    writeFileSync(file, JSON.stringify(historical) + '\n');
    fixture.realTranscript = true;
    fixture.agents = [{ sessionKey, workspace: process.cwd(), runtime: 'claude-code', status: 'idle', approvalStatus: 'none' }];
    try {
      expect((await PATCH(request({ sessionKey, inboxAction: 'unsettle' }))).status).toBe(200);
      const read = async () => (await (await inventory(new NextRequest('http://localhost/api/runtime/inventory'))).json()).agents[0];
      expect((await read()).settledOverride).toBe('active');
      writeFileSync(file, [historical, { type: 'user', uuid: 'new-run', timestamp: new Date(Date.now() + 1).toISOString(), message: { content: 'New run' } }].map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(await read()).not.toHaveProperty('settledOverride');
    } finally { fixture.realTranscript = false; }
  });

  it('rejects invalid actions and unknown or wrong-workspace subjects', async () => {
    const tabId = await seed('validation');
    expect((await mutate(tabId, 'invalid')).status).toBe(400);
    expect((await mutate(`${prefix}-missing`, 'settle')).status).toBe(404);
    expect((await PATCH(request({ tabId, inboxAction: 'settle' }, '?workspace=/different'))).status).toBe(404);
    expect((await PATCH(request({ sessionKey: 'codex:unknown', inboxAction: 'settle' }))).status).toBe(404);
  });
});
