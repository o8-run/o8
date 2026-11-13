import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const provider = vi.hoisted(() => ({ report: false, hold: null as Promise<void> | null }));
vi.mock('@/lib/lane/orchestrator-send-entry', () => ({
  sendOrchestratorBackendTurn: vi.fn(async (
    _backend: unknown, _repo: string, prompt: string, onEvent: (event: unknown) => void,
  ) => {
    await provider.hold;
    if (provider.report) {
      provider.report = false;
      const binding = prompt.match(/o8 lead report ([^ ]+) --turn ([^ ]+) --repo ([^ ]+) --thread-id ([^ ]+)/)!;
      const { reportLeadOutcome } = await import('@/lib/orchestrator/lead-lifecycle');
      reportLeadOutcome({ leadId: binding[1], turnId: binding[2], repoPath: JSON.parse(binding[3]),
        threadId: binding[4], kind: 'completed', summary: 'Fixture handback', evidence: ['fixture check passed'] });
    }
    onEvent({ type: 'text', text: 'Fixture turn ended' });
    onEvent({ type: 'done', sessionId: 'fixture-mcp-lead-session' });
  }),
}));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-lead-outcomes-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const prior = { O8_DATA_DIR: process.env.O8_DATA_DIR, CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  CORTEX_IDE_DB_PATH: process.env.CORTEX_IDE_DB_PATH, WS_TOKEN: process.env.WS_TOKEN };
Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), WS_TOKEN: 'mcp-lead-fixture-token-0123456789abcdef' });

const { getSqlite, closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const token = getOrCreateWsToken();
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ws-token'), token, { mode: 0o600 });
const lifecycle = await import('@/lib/orchestrator/lead-lifecycle');
const leadHttp = await import('@/lib/orchestrator/http/lead');
const missionHttp = await import('@/app/api/orchestrator/status/route');
const operatorHttp = await import('@/app/api/operator/status/route');
const mcpHttp = await import('@/app/api/mcp/route');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { recordMission } = await import('@/lib/db/missions-store');
let sequence = 0;
let missionReads = 0;
let leadsUnavailable = false;

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(join(repoPath, 'README.md'), 'MCP lead fixture\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'commit', '-qm', 'test: seed MCP lead fixture']);
  const { createProject, addRepoToProject } = await import('@/lib/projects/store');
  const { addRepo } = await import('@/lib/repos/registry');
  const project = createProject({ name: 'MCP fixture', slug: 'mcp-fixture' });
  const repo = await addRepo(repoPath);
  addRepoToProject(project.id, repo.id, 'fullstack');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined });
    switch (request.nextUrl.pathname) {
      case '/api/orchestrator/lead': return leadsUnavailable
        ? Response.json({ error: 'Fixture lead store unavailable' }, { status: 400 }) : leadHttp.GET(request);
      case '/api/orchestrator/status': {
        const response = await missionHttp.GET(request);
        missionReads += 1;
        return response;
      }
      case '/api/operator/status': return operatorHttp.GET(request);
      case '/api/panel/operator-defaults': return Response.json({ dispatchableRuntimes: [] });
      case '/api/panel/status': return Response.json({ ok: true });
      default: throw new Error(`Unexpected MCP fixture route: ${request.nextUrl.pathname}`);
    }
  }));
});

afterAll(async () => {
  provider.hold = null;
  lifecycle.__resetLeadRuntimeForTests();
  vi.unstubAllGlobals();
  closeDb();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function leadAction(body: Record<string, unknown>) {
  const response = await leadHttp.POST(new NextRequest('http://localhost/api/orchestrator/lead', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBeLessThan(300);
  return result as ReturnType<typeof lifecycle.getLeadStatus> & { admittedTurnId: string };
}

async function fixture(report: boolean) {
  provider.report = report;
  const started = await leadAction({ action: 'start', repoPath, backend: 'codex', model: 'gpt-5.6-sol',
    effort: 'high', idempotencyKey: `mcp-lead-${++sequence}`, brief: {
      objective: 'Own the fixture turn.', scope: ['fixture'], doneTests: ['fixture check'],
      nonGoals: [], budgets: [], escalationCriteria: ['fixture failure'],
    } });
  await vi.waitFor(() => expect(lifecycle.getLeadStatus(started.lead.id).lead.status)
    .toBe(report ? 'completed' : 'unreported'), { timeout: 5_000 });
  const packet = { id: `packet-${sequence}`, referenceLabel: 'P1', title: 'Previously released work',
    summary: 'The lead still owns its own turn outcome.', workspaceTargetPath: repoPath, branchTarget: 'main',
    runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], status: 'released', queueState: 'held',
    releaseState: 'released', orchestratorThreadId: started.lead.threadId } as OrchestratorPacket;
  const state = { ...createEmptyOrchestratorMissionState(), missionId: `mission-${sequence}`, repoPath, packets: [packet] };
  recordMission({ id: state.missionId, repoPath, runtime: 'codex', prompt: '', summary: '', constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }], missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  return { leadId: started.lead.id, missionId: state.missionId, packetId: packet.id };
}

type LeadView = { id: string; status: string; reason: string | null; result: unknown;
  updatedAt: number;
  latestTurn: { id: string; status: string; reason: string | null; outcome: unknown; error: string | null } };
type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
async function invoke(name: string, args: Record<string, unknown>) {
  const response = await mcpHttp.POST(new Request('http://localhost/api/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
  return body.result as ToolResult;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  let result = await invoke(name, args);
  let value = JSON.parse(result.content[0].text);
  if (value.schema === 'o8/mcp/result-page/v1') {
    let text = value.text;
    while (value.nextArguments) {
      value = JSON.parse((await invoke('o8_result_page', value.nextArguments)).content[0].text);
      text += value.text;
    }
    result = JSON.parse(text) as ToolResult;
  }
  return JSON.parse(result.content[0].text) as {
    leads?: LeadView[]; data?: { leads?: LeadView[]; agents?: unknown[]; leadsUnavailable?: boolean; leadsTruncated?: boolean };
    wakeReason?: string; terminalLeadId?: string;
  };
}
const tools = ['get_mission_status', 'wait_for_mission_ready', 'o8_status'] as const;
function leads(result: Awaited<ReturnType<typeof call>>) { return result.data?.leads ?? result.leads ?? []; }

function seedLeads(prefix: string, count: number) {
  const db = getSqlite();
  const lead = db.prepare(`INSERT INTO orchestrator_leads
    (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status,
     result_turn_id, result_status, created_at, updated_at)
    VALUES (?, ?, 'fixture', ?, ?, 'codex', 'fixture', 'high', 'unreported', ?, 'unreported', ?, ?)`);
  const turn = db.prepare(`INSERT INTO orchestrator_lead_turns
    (id, lead_id, idempotency_key, ordinal, kind, message, status, created_at, finished_at)
    VALUES (?, ?, 'fixture', 1, 'operator', 'Fixture turn', 'unreported', ?, ?)`);
  const now = Date.now() - 1000;
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}-${index}`;
      lead.run(id, id, `${id}-thread`, repoPath, `${id}-turn`, now + index, now + index);
      turn.run(`${id}-turn`, id, now + index, now + index);
    }
  })();
}

describe('durable lead outcomes through the MCP HTTP entry point', () => {
  it('keeps runtime status available without a cached lead handback when the lead store fails', async () => {
    const { leadId } = await fixture(true);
    const priorNativeReads = process.env.O8D_MCP_READS;
    process.env.O8D_MCP_READS = '1';
    try {
      const healthy = await call('o8_status', { sessionKey: leadId });
      expect(leads(healthy)[0]?.status).toBe('completed');
      const cached = (getSqlite().prepare("SELECT key, value FROM app_state WHERE key LIKE 'o8d/mcp/v1/status/%'")
        .all() as Array<{ key: string; value: string }>).find(row => row.value.includes(leadId));
      expect(cached).toBeDefined();
      leadsUnavailable = true;
      const degraded = await call('o8_status', { sessionKey: leadId });
      expect(degraded.data).toMatchObject({ agents: healthy.data?.agents, leadsUnavailable: true });
      expect(degraded.data?.leads).toBeUndefined();
      expect(getSqlite().prepare('SELECT key FROM app_state WHERE key = ?').get(cached!.key)).toBeUndefined();
      leadsUnavailable = false;
      const recovered = await call('o8_status', { sessionKey: leadId });
      expect(recovered.data?.leadsUnavailable).toBeUndefined();
      expect(leads(recovered)[0]?.status).toBe('completed');
    } finally {
      leadsUnavailable = false;
      if (priorNativeReads === undefined) delete process.env.O8D_MCP_READS; else process.env.O8D_MCP_READS = priorNativeReads;
    }
  });

  it('keeps lead projection reads constant as the result grows', async () => {
    seedLeads('batch-small', 3);
    await call('o8_status'); // Warm runtime observations before measuring the live lead projection.
    const measure = async () => {
      const prepare = vi.spyOn(getSqlite(), 'prepare');
      try {
        await call('o8_status');
        return prepare.mock.calls.filter(([sql]) => /^\s*SELECT\b/i.test(sql) && /orchestrator_lead/.test(sql)).length;
      } finally { prepare.mockRestore(); }
    };
    const small = await measure();
    seedLeads('batch-larger', 20);
    expect(await measure()).toBe(small);
    expect(small).toBeLessThanOrEqual(4);
  });

  it('bounds the overview to the 100 most recent leads and can inspect an older lead exactly', async () => {
    seedLeads('bounded', 105);
    const overview = await call('o8_status');
    expect(leads(overview)).toHaveLength(100);
    expect(overview.data?.leadsTruncated).toBe(true);
    const updated = leads(overview).map(lead => lead.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    expect(leads(overview).some(lead => lead.id === 'bounded-0')).toBe(false);
    const exact = leads(await call('o8_status', { sessionKey: 'bounded-0' }));
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({ id: 'bounded-0', status: 'unreported',
      reason: 'turn ended without an outcome report', latestTurn: { id: 'bounded-0-turn', outcome: null } });
  });

  it('documents repeated mission attention and overview limits through tool discovery', async () => {
    const response = await mcpHttp.POST(new Request('http://localhost/api/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
    const descriptions = new Map<string, string>((await response.json()).result.tools.map(
      (tool: { name: string; description: string }) => [tool.name, tool.description]));
    for (const name of ['get_mission_status', 'wait_for_mission_ready']) {
      expect(descriptions.get(name)).toContain('already-terminal');
      expect(descriptions.get(name)).toContain('attention');
    }
    expect(descriptions.get('o8_status')).toContain('100');
    expect(descriptions.get('o8_status')).toContain('leadsUnavailable');
    expect(descriptions.get('o8_status')).toContain('leadsTruncated');
  });

  it('preserves canonical receipt ownership when a result pointer names another lead turn', async () => {
    const missing = await fixture(false);
    const reported = await fixture(true);
    const reportedTurn = lifecycle.getLeadStatus(reported.leadId).latestTurn!.id;
    getSqlite().prepare('UPDATE orchestrator_leads SET result_turn_id = ? WHERE id = ?')
      .run(reportedTurn, missing.leadId);
    const canonical = lifecycle.getLeadStatus(missing.leadId);
    const projected = leads(await call('o8_status', { sessionKey: missing.leadId }))[0];
    expect(projected.result).toEqual(canonical.lead.result);
    expect(projected).toMatchObject({ status: 'unreported', latestTurn: { outcome: null } });
  });

  it('does not wake a packet-scoped wait just because its lead changes state', async () => {
    const { leadId, missionId, packetId } = await fixture(false);
    const state = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({ ...state, packets: state.packets.map(packet => ({ ...packet,
      status: 'draft', queueState: 'queued', releaseState: 'pending' })) });
    let release!: () => void;
    provider.hold = new Promise<void>(resolve => { release = resolve; });
    const before = missionReads;
    const pending = call('wait_for_mission_ready', { missionId, packetId, timeoutMs: 2000, pollIntervalMs: 1000 });
    try {
      await vi.waitFor(() => expect(missionReads).toBeGreaterThan(before));
      await leadAction({ action: 'send', leadId, message: 'More work', idempotencyKey: 'packet-scoped-more' });
      await vi.waitFor(() => expect(lifecycle.getLeadStatus(leadId).lead.status).toBe('running'));
      expect((await pending).wakeReason).toBe('timeout');
    } finally {
      release();
      provider.hold = null;
      await pending;
      await vi.waitFor(() => expect(lifecycle.getLeadStatus(leadId).lead.status).not.toBe('running'));
      await leadAction({ action: 'stop', leadId });
    }
  });

  it.each(tools)('%s returns unreported with the canonical turn and reason', async name => {
    const { leadId, missionId } = await fixture(false);
    const canonical = lifecycle.getLeadStatus(leadId);
    const result = await call(name, name === 'o8_status' ? {} : { missionId, timeoutMs: 1000 });
    expect(leads(result).find(lead => lead.id === leadId)).toMatchObject({
      status: 'unreported', reason: 'turn ended without an outcome report',
      latestTurn: { id: canonical.latestTurn!.id, status: 'unreported', outcome: null, error: null,
        reason: canonical.latestTurn!.reason },
    });
    if (name === 'wait_for_mission_ready') expect(result).toMatchObject({
      wakeReason: 'already-terminal', terminalLeadId: leadId,
    });
    if (name === 'o8_status') {
      const filtered = leads(await call(name, { sessionKey: leadId }));
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({ id: leadId, status: 'unreported', reason: canonical.latestTurn!.reason });
    }
  });

  it('hands back a recorded outcome and clears cached completion on new work', async () => {
    const { leadId, missionId } = await fixture(true);
    for (const name of tools) {
      const result = await call(name, name === 'o8_status' ? {} : { missionId, timeoutMs: 1000 });
      expect(leads(result).find(lead => lead.id === leadId)).toMatchObject({ status: 'completed',
        latestTurn: { outcome: { kind: 'completed', summary: 'Fixture handback', evidence: ['fixture check passed'] } } });
    }
    let release!: () => void;
    provider.hold = new Promise<void>(resolve => { release = resolve; });
    try {
      await leadAction({ action: 'send', leadId, message: 'More fixture work', idempotencyKey: 'more-work' });
      await vi.waitFor(() => expect(lifecycle.getLeadStatus(leadId).lead.status).toBe('running'));
      for (const name of tools) {
        const result = await call(name, name === 'o8_status' ? {} : { missionId, timeoutMs: 1000 });
        expect(leads(result).find(lead => lead.id === leadId)).toMatchObject({
          status: 'running', reason: null, result: null, latestTurn: { outcome: null },
        });
      }
    } finally {
      release();
      provider.hold = null;
      await vi.waitFor(() => expect(lifecycle.getLeadStatus(leadId).lead.status).toBe('unreported'));
    }
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE status = ?')
      .get('running')).toEqual({ count: 0 });
  });
});
