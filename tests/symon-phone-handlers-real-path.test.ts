import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { createLane, listLanes } from '@/lib/lane/registry';
import { closeDb } from '@/lib/db';
import { POST as createWatch } from '@/app/api/symon/watches/route';
import { phoneToolHandler, PHONE_SERVER_TOOLS, PHONE_TOOL_REVIEW_BUILDERS } from '@/lib/symon/execution/dispatcher';
import { createChildTerminalHost } from '@/lib/ws-server/terminal-host-client';
import type { TerminalHandle } from '@/lib/ws-server/terminal-host-protocol';
import { toolSafetyClass } from '@/lib/symon/execution/policy';
import { POST as controlAction } from '@/app/api/agent-control/action/route';
import type { AgentControlRequest, AgentControlResult } from '@/lib/agent-control/types';
import type { Json } from '@/lib/symon/execution/handlers/transport';

const h = vi.hoisted(() => ({
  perform: vi.fn<(request: AgentControlRequest) => Promise<AgentControlResult>>(async (request) => ({
    schema: 'o8/agent-control.result/v1' as const,
    ok: true,
    ref: request.ref,
    action: request.action.kind,
    clientMutationId: request.clientMutationId,
    status: 'completed' as const,
    note: 'Controlled once.',
    target: {
      schema: 'o8/agent-control.target/v1' as const,
      canonicalRef: request.ref,
      resolution: 'request' as const,
      runtime: null,
      surfaceId: request.ref.kind === 'session' ? request.ref.id : null,
      sessionKey: request.ref.kind === 'session' ? request.ref.id : null,
      projectId: null,
      repoPath: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      laneId: request.ref.kind === 'lane' ? request.ref.id : null,
      laneStatus: null,
      packetId: request.ref.kind === 'packet' ? request.ref.id : null,
      packetStatus: null,
      approval: { id: null, status: 'none' as const },
    },
  })),
  resolve: vi.fn(async (ref: AgentControlRequest['ref']) => ({
    schema: 'o8/agent-control.target/v1' as const,
    canonicalRef: ref,
    resolution: 'request' as const,
    runtime: null,
    surfaceId: ref.kind === 'session' ? ref.id : null,
    sessionKey: ref.kind === 'session' ? ref.id : null,
    projectId: null,
    repoPath: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    laneId: ref.kind === 'lane' ? ref.id : null,
    laneStatus: null,
    packetId: ref.kind === 'packet' ? ref.id : null,
    packetStatus: null,
    approval: { id: null, status: 'none' as const },
  })),
}));

vi.mock('@/lib/agent-control/service', () => ({
  performAgentControlAction: h.perform,
  resolveAgentControlTarget: h.resolve,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));


const terminalHost = createChildTerminalHost();
let terminal: TerminalHandle;
let terminalOutput = '';
const mutations: { path: string; body: Json }[] = [];
let requestCount = 0;
let pendingReceipts = 0;
let fail = false, head = 'head-1', fingerprint = 'diff-1', governance = 'governance-1', working = false, polls = 0;
const token = getOrCreateWsToken();
const repo = { id: 'repo-one', name: 'fixture', localPath: '/fixture' };
const approval = { id: 'approval-one', title: 'Merge fixture', toolName: 'orchestrator_review', metadata: { Packet: 'packet-one' } };
const server = createServer(async (req, res) => {
  requestCount++;
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  if (fail) { res.writeHead(503).end(); return; }
  const path = req.url!, chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Json : {};
  let result: unknown = {};
  if (req.method === 'POST') {
    if (['/api/orchestrator/delegate', '/api/orchestrator/steer-packet', '/api/orchestrator/rerun-with-feedback', '/api/orchestrator/reset-packet', '/api/agent-control/action', '/api/panel/approvals', '/terminal-voice-input', '/symon-orchestrator-turn'].includes(path)) mutations.push({ path, body });
    if (path === '/api/orchestrator/steer-packet' && pendingReceipts-- > 0) { res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ inProgress: true })); return; }
    if (path === '/api/agent-control/action') {
      const response = await controlAction(new NextRequest('http://localhost/api/agent-control/action', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text());
      return;
    }
    if (path === '/terminal-voice-input') terminal.write(body.raw ? String(body.text) : `${body.text}\r`);
    result = { ok: true, accepted: true, packetId: 'packet-new', laneId: 'lane-new', codename: 'fixture', sessionId: 'session', turnId: 'turn', result: { interruptedSessions: 1 } };
  } else if (path === '/api/panel/repos') result = { repos: [repo] };
  else if (path.startsWith('/api/lanes')) result = { lanes: listLanes() };
  else if (path.startsWith('/api/panel/approvals')) result = { approvals: [approval] };
  else if (path.startsWith('/api/orchestrator/review-state')) {
    polls++;
    result = { state: working ? 'working' : 'ready-to-merge', branch: 'fixture', spokenReview: { spokenSummary: 'One fixture file changed.', evidence: { headSha: head, fingerprint, governanceFingerprint: governance, stat: '1 file changed' } } };
  } else if (path === '/terminal-voice-sessions') result = { sessions: [{ name: 'owned-terminal', cwd: repo.localPath }] };
  else if (path === '/api/team/messages?limit=10') result = { messages: [{ text: 'fixture message' }] };
  else if (path === '/api/team/presence') result = { peers: [] };
  else if (path === '/api/projects') result = { projects: [{ name: 'Fixture project', repos: [repo] }] };
  else if (path === '/api/automations') result = { automations: [{ name: 'Fixture automation' }] };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
});
// Surface model-facing refusals as exceptions for the shared refusal assertions.
const call = async (tool: string, args: Json = {}, signal = new AbortController().signal) => {
  const result = await phoneToolHandler(tool, args, { signal }) as Json;
  if (typeof result.error === 'string' && !['unknown_tool', 'desktop_unavailable'].includes(result.error)) throw new Error(result.error);
  return result;
};
const scoped = { repoId: repo.id, repoPath: repo.localPath };
let laneId: string;
const argsFor = (tool: string): Json => {
  if (tool === 'o8_panel_read') return { kind: 'repos' };
  if (tool === 'o8_ask') return { question: 'What changed?' };
  if (tool === 'terminal_send') return { session_name: 'owned-terminal', text: 'fixture input' };
  if (tool === 'o8_stop_agent' || tool === 'o8_agent_task') return { ...scoped, laneId, task: 'Fixture task' };
  if (tool === 'o8_dispatch' || tool === 'o8_delegate') return { ...scoped, task: 'Fixture task' };
  return { ...scoped, packetId: 'packet-one', approvalId: approval.id, message: 'Fixture task' };
};
beforeAll(async () => {
  terminal = terminalHost.spawn({ file: '/bin/cat', args: [], cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
  terminal.onData(data => { terminalOutput += data; });
  await vi.waitFor(() => expect(terminal.pid).toBeGreaterThan(0), { timeout: 15000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  vi.stubEnv('O8_API_PORT', String(address.port)); vi.stubEnv('O8_WS_PORT', String(address.port));
  laneId = createLane({ repoPath: repo.localPath, packetId: 'packet-one', branch: 'fixture', baseBranch: 'main', runtime: 'codex', label: 'Fixture packet', ownership: 'managed', worktreePath: '/fixture-worktree', actor: 'system' }).id;
});
afterAll(async () => { terminal.kill(); terminalHost.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); vi.unstubAllEnvs(); });
beforeEach(() => { fail = false; head = 'head-1'; fingerprint = 'diff-1'; governance = 'governance-1'; working = false; polls = 0; pendingReceipts = 0; mutations.length = 0; });

describe('phone server dispatcher over authenticated HTTP and persisted state', () => {
  it.each(PHONE_SERVER_TOOLS.filter(t => !['symon_watch_list', 'symon_watch_cancel'].includes(t)))('%s succeeds and refuses unavailable or invalid targets', async tool => {
    let args = argsFor(tool);
    if (tool === 'o8_approve_item' || tool === 'o8_reject_item') {
      const reviewed = await call('o8_review_diff', args) as Json;
      args = { ...args, reviewReceipt: reviewed.reviewReceipt };
    }
    const result = await call(tool, args) as Json;
    expect(result).toBeDefined(); expect(result.error).toBeUndefined();
    if (tool === 'o8_ask') expect(result).toEqual({ answer: '', sources: [], sources_considered: 0 });
    if (tool === 'o8_dispatch') expect(result).toMatchObject({ dispatched: true, packetId: 'packet-new' });
    if (tool === 'o8_status') expect(result).toMatchObject({ active_count: 1, repoId: repo.id, lanes: [expect.objectContaining({ laneId, packetId: 'packet-one' })] });
    fail = true;
    await expect(call(tool, args)).rejects.toThrow();
  });
  it.each(['o8_packet_steer', 'o8_packet_wait', 'o8_packet_rerun', 'o8_packet_reset', 'o8_stop_agent', 'o8_agent_task', 'o8_review_diff', 'o8_approve_item', 'o8_reject_item', 'o8_dispatch', 'o8_delegate', 'o8_status', 'o8_needs_me'])('%s refuses scope escapes without a mutation', async tool => {
    await expect(call(tool, { ...argsFor(tool), repoId: 'other', repoPath: '/elsewhere' })).rejects.toThrow();
    expect(mutations).toHaveLength(0);
  });
  it.each(['o8_packet_steer', 'o8_packet_rerun', 'o8_packet_reset', 'o8_packet_wait', 'o8_review_diff'])('%s refuses missing packets', async tool => {
    await expect(call(tool, { ...argsFor(tool), packetId: 'missing' })).rejects.toThrow('No lane');
    expect(mutations).toHaveLength(0);
  });
  it('refuses existing packets and approvals from another registered repository', async () => {
    createLane({ repoPath: '/other', packetId: 'other-packet', branch: 'fixture', baseBranch: 'main', runtime: 'codex', label: 'Other packet', ownership: 'managed', worktreePath: '/other-worktree', actor: 'system' });
    await expect(call('o8_packet_reset', { ...scoped, packetId: 'other-packet' })).rejects.toThrow('outside');
    await expect(call('o8_approve_item', { ...scoped, approvalId: 'absent' })).rejects.toThrow('No pending approval');
    approval.metadata.Packet = 'other-packet';
    try { await expect(call('o8_approve_item', { ...scoped, approvalId: approval.id })).rejects.toThrow('outside'); }
    finally { approval.metadata.Packet = 'packet-one'; }
    expect(mutations).toHaveLength(0);
  });
  it.each(['head', 'diff', 'governance', 'title', 'expired'])('refuses stale %s at card preparation and execution', async changed => {
    const args = argsFor('o8_review_diff'), reviewed = await call('o8_review_diff', args) as Json;
    const ready = { ...args, reviewReceipt: reviewed.reviewReceipt };
    const builder = PHONE_TOOL_REVIEW_BUILDERS.o8_approve_item;
    await expect(builder(ready, { signal: new AbortController().signal })).resolves.toMatchObject({ summary: expect.stringContaining(approval.title), target: { approvalId: approval.id, packetId: 'packet-one' } });
    const oldTitle = approval.title;
    if (changed === 'head') head = 'new-head';
    if (changed === 'diff') fingerprint = 'new-diff';
    if (changed === 'governance') governance = 'new-governance';
    if (changed === 'title') approval.title = 'Changed title';
    if (changed === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try {
      await expect(builder(ready, { signal: new AbortController().signal })).rejects.toThrow();
      await expect(call('o8_approve_item', ready)).rejects.toThrow();
      expect(mutations).toHaveLength(0);
    } finally { approval.title = oldTitle; vi.restoreAllMocks(); }
  });
  it('delivers confirmed terminal input through the existing real PTY host fixture', async () => {
    await call('terminal_send', { session_name: 'owned-terminal', text: 'phone-pty-fixture' });
    await vi.waitFor(() => expect(terminalOutput).toContain('phone-pty-fixture'), { timeout: 15000 });
    await expect(call('terminal_send', { session_name: 'foreign', text: 'do not send' })).rejects.toThrow('session not found');
  });
  it('redacts credential text in confirmation cards', async () => {
    const review = await PHONE_TOOL_REVIEW_BUILDERS.terminal_send({ session_name: 'owned-terminal', text: 'Authorization: Bearer fixture-secret-123456789' }, { signal: new AbortController().signal });
    expect(review.summary).not.toContain('fixture-secret-123456789');
    expect(review.summary).toContain('owned-terminal');
  });
  it('executes the lane control through the production authenticated control route', async () => {
    h.perform.mockClear();
    expect(await call('o8_agent_task', { ...scoped, laneId, task: 'Follow up' })).toMatchObject({ steered: true, laneId });
    expect(h.perform).toHaveBeenCalledWith(expect.objectContaining({ ref: { kind: 'lane', id: laneId }, action: { kind: 'send_turn', message: 'Follow up' } }));
  });
  it('retains the classic dispatcher protected-path refusal', async () => {
    await expect(call('o8_packet_reset', { ...argsFor('o8_packet_reset'), path: '/etc/protected' })).rejects.toThrow('protected system path');
    expect(mutations).toHaveLength(0);
  });
  it('returns structured model refusals through the actual handler', async () => {
    expect(await phoneToolHandler('o8_packet_reset', { packetId: 'absent' }, { signal: new AbortController().signal })).toMatchObject({ error: expect.stringContaining('No lane') });
  });
  it('consumes receipts once and sends all bound evidence to the approval route', async () => {
    const args = argsFor('o8_review_diff'), reviewed = await call('o8_review_diff', args) as Json, ready = { ...args, reviewReceipt: reviewed.reviewReceipt };
    await call('o8_reject_item', { ...ready, reason: 'Needs work' });
    expect(mutations[0].body).toEqual({ action: 'reject', id: approval.id, reason: 'Needs work', spokenReviewEvidence: { approvalId: approval.id, packetId: 'packet-one', reviewedHeadSha: head, reviewedDiffFingerprint: fingerprint, reviewedGovernanceFingerprint: governance } });
    await expect(call('o8_approve_item', ready)).rejects.toThrow('already used');
  });
  it('reuses exactly one mutation identity until a correlated route settles', async () => {
    pendingReceipts = 1;
    await call('o8_packet_steer', argsFor('o8_packet_steer'));
    expect(mutations).toHaveLength(2);
    expect(mutations[0].body).toEqual(mutations[1].body);
  });
  it('aborts a polling wait and performs no later reads', async () => {
    working = true;
    const controller = new AbortController(), waiting = call('o8_packet_wait', argsFor('o8_packet_wait'), controller.signal);
    await vi.waitFor(() => expect(polls).toBe(1));
    controller.abort(); await expect(waiting).rejects.toThrow();
    const count = polls;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(polls).toBe(count);
  });
  it('provides a trusted review naming each gated target', async () => {
    for (const tool of PHONE_SERVER_TOOLS.filter(t => toolSafetyClass(t) !== 'read-only' && t !== 'symon_watch_cancel')) {
      let args = argsFor(tool);
      if (tool === 'o8_approve_item' || tool === 'o8_reject_item') args = { ...args, reviewReceipt: (await call('o8_review_diff', args) as Json).reviewReceipt };
      expect(Object.hasOwn(PHONE_TOOL_REVIEW_BUILDERS, tool)).toBe(true);
      const review = await PHONE_TOOL_REVIEW_BUILDERS[tool](args, { signal: new AbortController().signal });
      expect(review.summary).toContain(tool.startsWith('terminal') ? 'owned-terminal' : tool === 'o8_dispatch' || tool === 'o8_delegate' ? repo.name : tool.includes('approve') || tool.includes('reject') ? approval.title : tool === 'o8_stop_agent' || tool === 'o8_agent_task' ? laneId : 'packet-one');
    }
  });
  it('lists and cancels real persisted watch records without running their plans', async () => {
    const response = await createWatch(new Request('http://localhost/api/symon/watches', { method: 'POST', body: JSON.stringify({ sessionId: 'phone-one', condition: { text: 'Fixture condition', source: 'packet', id: 'packet-one', repoPath: repo.localPath }, then: { kind: 'report', say: 'Ready' } }) }));
    expect(response.status).toBe(200);
    const { watch } = await response.json();
    const args = { ...scoped, id: watch.id, __symonSessionId: 'phone-one' };
    expect(await call('symon_watch_list', args)).toMatchObject({ count: 1, watches: [expect.objectContaining({ id: watch.id })] });
    expect(await PHONE_TOOL_REVIEW_BUILDERS.symon_watch_cancel(args, { signal: new AbortController().signal })).toMatchObject({ summary: expect.stringContaining('Fixture condition') });
    await expect(call('symon_watch_cancel', { ...args, __symonSessionId: 'other' })).rejects.toThrow('not found');
    await expect(call('symon_watch_cancel', { ...args, id: 'absent' })).rejects.toThrow('not found');
    expect(await call('symon_watch_cancel', args)).toMatchObject({ cancelled: true, watch: { id: watch.id, state: 'closed' } });
    const controller = new AbortController(); controller.abort();
    await expect(call('symon_watch_list', args, controller.signal)).rejects.toThrow();
    expect(mutations).toHaveLength(0);
  });
  it.each(['symon_execute_plan', 'symon_machine_list', 'symon_machine_switch', 'symon_ledger_recent', 'symon_ledger_undo', 'symon_watch', 'symon_watch_run', 'agent_turn', 'escalate', 'git_status', 'gh_comment'])('%s stays unavailable', async tool => {
    expect(await call(tool)).toEqual({ error: 'desktop_unavailable' }); expect(mutations).toHaveLength(0);
  });
  it.each(['unknown', '__proto__', 'constructor', 'toString'])('unknown %s executes nothing', async tool => {
    const before = requestCount;
    expect(await call(tool)).toEqual({ error: 'unknown_tool' });
    expect(requestCount).toBe(before); expect(mutations).toHaveLength(0);
  });
});
