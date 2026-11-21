import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const steer = vi.hoisted(() => vi.fn(async () => ({ packetId: 'packet-plugin', laneId: 'lane-plugin', note: 'accepted' })));
// The external worker dispatch is the fake boundary; HTTP auth, durable mission
// lookup, idempotency, and the local audit file below are production paths.
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ steerPacket: steer }));

import { POST } from '@/app/api/plugins/mcp/route';
import { GET as audit } from '@/app/api/plugins/audit/route';
import { mintPluginToken, resolvePluginToken } from '@/lib/auth/plugin-token';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { getDataDir } from '@/lib/data-dir-migration';
import { getDb, laneEvents, lanes, sessionOutcomes } from '@/lib/db';
import { createLane } from '@/lib/lane/registry';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';
import { __resetIdempotencyStoreForTests } from '@/lib/orchestrator/idempotency-store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { panelGateMiddleware } from '@/middleware';

function token(scopes = ['o8:read', 'o8:follow-up']) {
  return mintPluginToken({ machineId: 'machine-plugin', clientId: 'client-plugin', scopes });
}
function request(name: string, args: Record<string, unknown>, bearer = token(), path = '/api/plugins/mcp') {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}
function seed(overrides: Partial<OrchestratorPacket> = {}) {
  const packet: OrchestratorPacket = {
    id: 'packet-plugin', referenceLabel: 'P1', title: 'Check a task', summary: 'In progress',
    workspaceTargetPath: null, branchTarget: 'codex/test', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'running',
    ...overrides,
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-plugin', repoPath: '/test/project', packets: [packet] });
}
const selected = { machineId: 'machine-plugin', missionId: 'mission-plugin', packetId: 'packet-plugin' };

function resultFixture(status: OrchestratorPacket['status'] = 'awaiting_review') {
  const packetId = `plugin-result-${randomUUID()}`;
  const sessionKey = `codex-owned:${randomUUID()}`;
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  seed({ id: packetId, status, summary: 'ORIGINAL_TASK_INSTRUCTIONS', completionSummary: 'OLD_COMPLETION' });
  const lane = createLane({
    repoPath: '/test/project', projectId: 'plugin-test-project', branch: 'plugin-result',
    runtime: 'codex', packetId, sessionKey, baseCommit: 'a'.repeat(40),
  });
  getDb()!.update(lanes).set({ createdAt: startedAt }).where(eq(lanes.id, lane.id)).run();
  getDb()!.update(laneEvents).set({ timestamp: startedAt }).where(eq(laneEvents.laneId, lane.id)).run();
  function outcome(overrides: Partial<typeof sessionOutcomes.$inferInsert> = {}) {
    getDb()!.insert(sessionOutcomes).values({
      id: randomUUID(), packetId, laneId: lane.id, sessionKey, repoPath: '/test/project',
      runtime: 'codex', outcome: 'succeeded', summary: 'Outcome: Both totals recorded. Evidence: Exact bytes verified. Residual: Awaiting operator review.',
      startedAt, completedAt: new Date(Date.now() - 1_000).toISOString(), changedFilesJson: '["north-total.txt"]',
      ...overrides,
    }).run();
  }
  return { lane, sessionKey, packetId, startedAt, outcome, args: { ...selected, packetId } };
}

beforeEach(() => { steer.mockClear(); __resetIdempotencyStoreForTests(); seed(); });

describe('plugin principal through the real API and persisted state', () => {
  it('returns the durable current worker report instead of task instructions or an old completion', async () => {
    const fixture = resultFixture();
    fixture.outcome();
    const response = await POST(request('o8_result', fixture.args));
    const task = (await response.json()).result.structuredContent.task;
    expect(task).toMatchObject({
      status: 'awaiting_review', needsOperator: true,
      summary: expect.stringContaining('Both totals recorded'),
      completion: { available: true, source: 'worker_report', outcome: 'succeeded', changedFileCount: 1 },
    });
    expect(task.summary).toContain('Exact bytes verified');
    expect(task.summary).toContain('Awaiting operator review');
    expect(JSON.stringify(task)).not.toMatch(/ORIGINAL_TASK_INSTRUCTIONS|OLD_COMPLETION/);
  });

  it('reports unavailable evidence when the result is missing, belongs to another session, or precedes a follow-up', async () => {
    for (const invalid of ['missing', 'session', 'lane', 'repo', 'follow-up', 'future', 'malformed'] as const) {
      const fixture = resultFixture();
      if (invalid !== 'missing') fixture.outcome({
        ...(invalid === 'session' ? { sessionKey: 'another-session' } : {}),
        ...(invalid === 'lane' ? { laneId: 'another-lane' } : {}),
        ...(invalid === 'repo' ? { repoPath: '/another/repo' } : {}),
        ...(invalid === 'future' ? { completedAt: new Date(Date.now() + 60_000).toISOString() } : {}),
        ...(invalid === 'malformed' ? { completedAt: 'invalid-time' } : {}),
        ...(invalid === 'follow-up' ? { completedAt: new Date(Date.now() - 20_000).toISOString() } : {}),
      });
      if (invalid === 'follow-up') getDb()!.insert(laneEvents).values({
        id: randomUUID(), laneId: fixture.lane.id, verb: 'steered_packet', actor: 'orchestrator',
        timestamp: new Date(Date.now() - 10_000).toISOString(), payloadJson: '{}',
      }).run();
      const task = (await (await POST(request('o8_result', fixture.args))).json()).result.structuredContent.task;
      expect(task.completion, invalid).toMatchObject({ available: false });
      expect(task.summary, invalid).toContain('unavailable');
      expect(JSON.stringify(task), invalid).not.toMatch(/ORIGINAL_TASK_INSTRUCTIONS|OLD_COMPLETION|Both totals recorded/);
    }
  });

  it('keeps a running task separate from its previous completion receipt', async () => {
    const fixture = resultFixture('running');
    fixture.outcome();
    const task = (await (await POST(request('o8_result', fixture.args))).json()).result.structuredContent.task;
    expect(task.completion).toMatchObject({ available: false, reason: 'in_progress' });
    expect(task.summary).not.toContain('Both totals recorded');
  });

  it('bounds worker reports and omits fenced code, credentials, private paths and transcript locations', async () => {
    const fixture = resultFixture();
    fixture.outcome({
      summary: 'Evidence: north-total.txt verified. src/example.ts /Users/example/private/result.txt C:\\Users\\example\\secret.txt file:/Users/example/private/transcript.jsonl Path:/Users/example/private/transcript.jsonl file:///Users/example/private/result.txt ~/private/result.txt \\\\private-host\\share\\result.txt sk-proj-SYNTHETIC_NOT_A_REAL_SECRET_1234567890 token=private-value Bearer private-bearer https://example.invalid/report?code=private-code HTTPS://private-url-user:private-url-pass@example.invalid/upper?account=private-query#private-fragment ```secret code``` ' + 'x'.repeat(4_000),
      transcriptPath: '/private/transcript.jsonl', changedFilesJson: '["/Users/example/private/result.txt"]',
    });
    const task = (await (await POST(request('o8_result', fixture.args))).json()).result.structuredContent.task;
    expect(task.completion.available).toBe(true);
    expect(task.summary.length).toBeLessThanOrEqual(1_200);
    expect(task.summary).toContain('north-total.txt verified');
    expect(task.summary).toContain('src/example.ts');
    expect(task.summary).toContain('https://example.invalid/report');
    expect(task.summary).toContain('https://example.invalid/upper');
    expect(JSON.stringify(task)).not.toMatch(/private-value|private-bearer|private-code|private-url-user|private-url-pass|private-query|private-fragment|secret code|Users|transcript|private-host|SYNTHETIC_NOT_A_REAL_SECRET|codex-owned/);
    expect(Buffer.byteLength(JSON.stringify(task))).toBeLessThan(4_000);
  });

  it('reads bounded status and persists a plugin-attributed audit without payloads', async () => {
    const req = request('o8_attention', { machineId: 'machine-plugin' });
    expect(resolveRequestPrincipal(req)).toBe('plugin');
    expect(panelGateMiddleware(req).status).toBe(200);
    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.structuredContent.tasks[0]).toMatchObject({ missionId: 'mission-plugin', packetId: 'packet-plugin', project: 'project' });
    expect(JSON.stringify(body)).not.toContain('/test/project');
    const entries = readPluginAudit();
    expect(entries.at(-1)).toMatchObject({ actor: 'plugin', surface: 'chatgpt', clientId: 'client-plugin', phase: 'finished', outcome: 'success' });
    expect(statSync(join(getDataDir(), 'plugin-audit.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('deduplicates an exact follow-up across a new credential and rejects key reuse with new content', async () => {
    const args = { ...selected, message: 'Please check the tests.', idempotencyKey: 'exact-retry' };
    expect((await POST(request('o8_follow_up', args))).status).toBe(200);
    const second = await POST(request('o8_follow_up', args, token()));
    expect((await second.json()).result.structuredContent).toMatchObject({ accepted: true, completed: false, replayed: true });
    const conflict = await POST(request('o8_follow_up', { ...args, message: 'A different task.' }));
    expect((await conflict.json()).result.structuredContent.code).toBe('idempotency_key_conflict');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(getDataDir(), 'plugin-audit.jsonl'), 'utf8')).not.toContain(args.message);
  });

  it('refuses approval, merge, unrestricted MCP, and every other route even when public', async () => {
    for (const path of ['/api/panel/approvals', '/api/mcp', '/api/mobile/enroll', '/api/plugins/audit', '/api/plugins/mcp/extra']) {
      expect(panelGateMiddleware(request('approve', {}, token(), path)).status).toBe(403);
    }
    for (const name of ['approve_and_merge', 'o8_exec', 'approve']) {
      expect((await POST(request(name, selected))).status).toBe(403);
    }
    expect((await audit(request('unused', {}, token()))).status).toBe(403);
    expect(steer).not.toHaveBeenCalled();
  });

  it('enforces granted scope, machine binding, and stopped-task holds', async () => {
    const args = { ...selected, message: 'Keep working.', idempotencyKey: 'denied' };
    expect((await POST(request('o8_follow_up', args, token(['o8:read'])))).status).toBe(403);
    expect((await POST(request('o8_result', { ...selected, machineId: 'other-machine' }))).status).toBe(403);
    seed({ operatorStopped: true });
    expect((await (await POST(request('o8_follow_up', args))).json()).result.structuredContent.code).toBe('task_unavailable');
    expect(steer).not.toHaveBeenCalled();
  });

  it('excludes old released work, puts blockers first, and exposes further pages', async () => {
    seed();
    const state = createEmptyOrchestratorMissionState();
    const packet = {
      id: 'base', referenceLabel: 'P1', title: 'A'.repeat(160), summary: 'B'.repeat(160),
      workspaceTargetPath: null, branchTarget: 'codex/test', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'running',
    } as OrchestratorPacket;
    const packets = [
      ...Array.from({ length: 25 }, (_, index) => ({ ...packet, id: `old-${index}`, releaseState: 'released' as const })),
      ...Array.from({ length: 22 }, (_, index) => ({ ...packet, id: `live-${index}` })),
      { ...packet, id: 'blocker', status: 'blocked' as const },
    ];
    writeOrchestratorControlPlaneState({ ...state, missionId: 'mission-plugin', packets });
    const response = await POST(request('o8_attention', { machineId: 'machine-plugin' }));
    const body = await response.json();
    expect(body.result.structuredContent.tasks[0].packetId).toBe('blocker');
    expect(body.result.structuredContent).toMatchObject({ totalTasks: 23, nextCursor: '20' });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(65_536);
    const next = await POST(request('o8_attention', { machineId: 'machine-plugin', cursor: '20' }));
    expect((await next.json()).result.structuredContent.tasks).toHaveLength(3);
  });

  it('rejects forged and expired credentials at both the gate and handler', async () => {
    const issued = token();
    const expired = mintPluginToken({ machineId: 'machine-plugin', clientId: 'client-plugin', scopes: ['o8:read'] }, { now: Date.now() - 61_000 });
    for (const value of [`${issued.slice(0, -5)}abcde`, expired, 'operator-not-a-plugin']) {
      expect(resolvePluginToken(value)).toBeNull();
      expect(panelGateMiddleware(request('o8_attention', {}, value)).status).toBe(401);
      expect((await POST(request('o8_attention', {}, value))).status).toBe(401);
    }
  });
});
