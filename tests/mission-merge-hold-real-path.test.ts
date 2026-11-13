/**
 * Mission merge hold (#3740) — real path.
 *
 * A lead told "do not merge" creates its mission with `holdMerges` through the
 * operator MCP (`/api/mcp` → create_mission → `/api/orchestrator/create-mission`).
 * The packet's lane then has a real worktree and an approved review. The
 * reviewer's or lead's merge call must route to an operator card and leave the
 * base branch alone; the operator's approval of that card merges. A mission
 * without the hold still merges on the same call.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';

vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-merge-hold-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
mkdirSync(dataDir); mkdirSync(repoPath);
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '--bare', origin]);
git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.name', 'o8 test');
git(repoPath, 'config', 'user.email', 'test@example.invalid');
writeFileSync(join(repoPath, 'file.txt'), 'base\n');
git(repoPath, 'add', 'file.txt');
git(repoPath, 'commit', '-qm', 'base');
git(repoPath, 'remote', 'add', 'origin', origin); git(repoPath, 'push', '-q', '-u', 'origin', 'main');
execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), O8_OPERATOR_MCP_PROFILE: 'full',
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0' })) vi.stubEnv(key, value);
const token = 'merge-hold-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);

const setupRoute = await import('@/app/api/setup/agent/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const mcpRoute = await import('@/app/api/mcp/route');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const correctionsRoute = await import('@/app/api/orchestrator/worker-corrections/route');
const approvalsRoute = await import('@/app/api/panel/approvals/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb } = await import('@/lib/db');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { recordOrchestratorReview, getApproval, listApprovalsForContext } = await import('@/lib/approvals/store');
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { openO8Servers } = await import('@/lib/pi/orchestrator/o8-servers');

let port = 0;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : req.url === '/api/orchestrator/merge' ? await mergeRoute.POST(request)
      : req.url === '/api/orchestrator/worker-corrections' ? req.method === 'GET' ? await correctionsRoute.GET(request) : await correctionsRoute.POST(request)
      : req.url?.startsWith('/api/orchestrator/worker-corrections?') ? await correctionsRoute.GET(request)
      : req.url === '/api/panel/approvals' ? await approvalsRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});

/** One operator MCP tool call, the way a lead makes it: the operator token over /api/mcp. */
async function callTool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()).result as McpToolResult;
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await callTool(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}

/** create_mission through the operator MCP, then a real worktree, commit and approved review for its packet. */
async function reviewedPacket(label: string, holdMerges?: boolean, orchestratorThreadId?: string) {
  const created = await call('create_mission', {
    repoPath, runtime: 'codex', dispatch: false, taskContract: 'off', ...(orchestratorThreadId ? { orchestratorThreadId } : {}),
    issues_inline: [{ title: `Change file ${label}`, body: 'Owned fixture.' }],
    ...(holdMerges === undefined ? {} : { holdMerges }),
  });
  const packet = readMissionRegistryEntry(created.missionId)!.mission.packets[0]!;
  const branch = `inline/merge-hold-${label}-${Date.now()}`;
  const worktree = await getWorktreeManager(repoPath).create({
    agentType: 'codex', taskName: packet.id, branchName: branch, baseBranch: 'main',
    packetId: packet.id, skipSetup: true, isolationPreference: 'git-worktree',
  });
  git(worktree.path, 'config', 'user.name', 'o8 test');
  git(worktree.path, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(worktree.path, `${label}.txt`), `${label}\n`);
  git(worktree.path, 'add', '-A');
  git(worktree.path, 'commit', '-qm', `change ${label}`);
  const reviewedHeadSha = git(worktree.path, 'rev-parse', 'HEAD');
  const lane = createLane({
    repoPath, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex',
    packetId: packet.id, sessionKey: `codex:${packet.id}`, label: `Merge hold ${label}`,
  });
  recordOrchestratorReview(packet.id, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha, requiresSecondPass: false });
  return { packet, lane, reviewedHeadSha };
}

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'api-port'), String(port));
  // The cortex stdio server is a child process; it finds the API from these.
  vi.stubEnv('O8_API_PORT', String(port)); vi.stubEnv('NEXT_ORIGIN', `http://127.0.0.1:${port}`);
  await call('o8_setup', { action: 'open', path: repoPath });
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('holds an approved packet from a held mission until the operator approves the merge', async () => {
  const { packet, lane } = await reviewedPacket('held', true);
  expect(packet.mergeHold).toBe(true);
  const baseHeadSha = git(repoPath, 'rev-parse', 'main');

  // The reviewer's and the lead's merge both arrive as actor 'orchestrator'.
  const held = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
  expect(held.ok).toBe(false);
  expect(held.approvalId).toBeTruthy();
  expect(getApproval(held.approvalId!)).toMatchObject({ status: 'pending', policyRuleId: 'mission-merge-hold', title: 'Merge held' });
  expect(git(repoPath, 'rev-parse', 'main')).toBe(baseHeadSha);
  expect(getLane(lane.id)?.status).not.toBe('completed');

  // A second automatic attempt is held too; nothing reaches the base branch.
  const again = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
  expect(again.ok).toBe(false);
  expect(git(repoPath, 'rev-parse', 'main')).toBe(baseHeadSha);

  // The lead's own tools share the operator token. In this order the old merge
  // route resolved the card itself, failed on the moved HEAD and left the card
  // approved, so the next approve_and_merge inherited it and merged.
  writeFileSync(join(lane.worktreePath!, 'held-follow-up.txt'), 'follow-up\n');
  git(lane.worktreePath!, 'add', '-A');
  git(lane.worktreePath!, 'commit', '-qm', 'follow-up');
  const followUpHeadSha = git(lane.worktreePath!, 'rev-parse', 'HEAD');
  const leadMerge = await callTool('approve_and_merge', { packetId: packet.id });
  expect(JSON.stringify(leadMerge)).not.toMatch(/"merged\\?":\s*true/);
  expect(getApproval(held.approvalId!)?.status).toBe('pending');
  recordOrchestratorReview(packet.id, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: followUpHeadSha, requiresSecondPass: false });
  const followUpMerge = await callTool('approve_and_merge', { packetId: packet.id });
  expect(JSON.stringify(followUpMerge)).not.toMatch(/"merged\\?":\s*true/);
  expect(git(repoPath, 'rev-parse', 'main')).toBe(baseHeadSha);
  const leadApprove = await callTool('o8_approve', { id: held.approvalId });
  expect(leadApprove.isError).toBe(true);
  expect(JSON.stringify(leadApprove)).toContain('holds merges');
  // The cortex server the lead also gets resolves approvals the same way.
  const servers = await openO8Servers(repoPath, { profile: 'full', threadId: 'thoughts-merge-hold' });
  try {
    const cortex = servers.servers.find((server) => server.name === 'cortex')!;
    const cortexApprove = await cortex.request('tools/call', { name: 'cortex_resolve_approval',
      arguments: { id: held.approvalId, action: 'approve' } }, new AbortController().signal) as McpToolResult;
    expect(cortexApprove.isError).toBe(true);
    expect(JSON.stringify(cortexApprove)).toContain('holds merges');
  } finally { await servers.close(); }
  expect(getApproval(held.approvalId!)?.status).toBe('pending');
  expect(git(repoPath, 'rev-parse', 'main')).toBe(baseHeadSha);
  const pendingCard = listApprovalsForContext({ laneId: lane.id })
    .filter((approval) => approval.status === 'pending' && approval.policyRuleId === 'mission-merge-hold')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  expect(pendingCard).toBeTruthy();

  const approved = await approvalsRoute.POST(new NextRequest(`http://127.0.0.1:${port}/api/panel/approvals`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', id: pendingCard!.id }),
  }));
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(git(repoPath, 'rev-parse', 'main')).toBe(followUpHeadSha);
}, 120_000);

it('keeps the usual merge after an approved review when the mission does not hold merges', async () => {
  const { packet, lane, reviewedHeadSha } = await reviewedPacket('unheld');
  expect(packet.mergeHold).toBeUndefined();

  const merged = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
  expect(merged.ok, merged.note).toBe(true);
  expect(git(repoPath, 'rev-parse', 'main')).toBe(reviewedHeadSha);
}, 120_000);


it('rejects an old operator approval after a typed correction through the real cortex tool', async () => {
  const threadId = 'thoughts-restricted-merge';
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({ repoPath, messages: [] }));
  const { packet, lane } = await reviewedPacket('late-restriction', true, threadId);
  expect(packet.orchestratorThreadId).toBe(threadId);
  const held = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
  expect(held.approvalId).toBeTruthy();
  const localBefore = git(repoPath, 'rev-parse', 'main');
  const remoteBefore = git(origin, 'rev-parse', 'main');
  const servers = await openO8Servers(repoPath, { profile: 'full', threadId });
  try {
    const cortex = servers.servers.find(server => server.name === 'cortex')!;
    const restriction = await cortex.request('tools/call', { name: 'cortex_correct_workers', arguments: {
      idempotencyKey: 'late-merge-restriction', message: 'Do not merge. Keep this for review.', mode: 'send', holdMerges: true, targets: [],
    } }, new AbortController().signal) as McpToolResult;
    expect(restriction.isError, JSON.stringify(restriction)).not.toBe(true);
    expect(JSON.stringify(restriction)).toContain('ruleId');
  } finally { await servers.close(); }
  const response = await approvalsRoute.POST(new NextRequest(`http://127.0.0.1:${port}/api/panel/approvals`, {
    method: 'POST', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', id: held.approvalId }),
  }));
  expect(await response.text()).toContain('Merge blocked by an operator session rule');
  const replay = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'user' });
  expect(replay.ok).toBe(false); expect(replay.note).toContain('Merge blocked');
  expect(git(repoPath, 'rev-parse', 'main')).toBe(localBefore);
  expect(git(origin, 'rev-parse', 'main')).toBe(remoteBefore);
}, 120_000);
