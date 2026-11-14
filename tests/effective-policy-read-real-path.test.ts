import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-policy-read-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repoPath = join(dataDir, 'repo');
mkdirSync(repoPath);
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(join(repoPath, 'fixture.txt'), 'fixture\n');
execFileSync('git', ['add', 'fixture.txt'], { cwd: repoPath });
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: repoPath });
const { createLane } = await import('@/lib/lane/registry');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { createProject } = await import('@/lib/projects/store');
const project = createProject({ name: 'Policy fixture' });
const lane = createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: 'pkt-policy', branch: 'policy', runtime: 'codex' });
function persist(mergeHold = false, attemptCount = 0) {
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-policy', repoPath,
    packets: [{ id: 'pkt-policy', referenceLabel: 'policy', workspaceTargetPath: repoPath, branchTarget: lane.branch, title: 'Policy', summary: 'Policy', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'queued', releaseState: 'pending', status: 'queued', lane: null, mergeHold, attemptCount }] });
  closeDb();
}
function request(token = getOrCreateWsToken()) {
  return new NextRequest(`http://localhost/api/lanes/${lane.id}/policy`, { headers: { host: 'localhost', authorization: `Bearer ${token}` } });
}
async function read(token?: string) {
  const { GET } = await import('@/app/api/lanes/[id]/policy/route');
  return GET(request(token), { params: Promise.resolve({ id: lane.id }) });
}
afterAll(() => { vi.unstubAllGlobals(); delete process.env.O8_REVIEW_MODE; closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

it('reads persisted fresh policy through the route, retaining PR-first completion', async () => {
  persist();
  const response = await read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema: 'o8/effective-policy/v1', laneId: lane.id,
    reviewMode: { value: 'automatic', precedence: 'inherited' },
    mergeMode: { value: 'direct', precedence: 'inherited' },
    nextAction: { value: 'human', reason: expect.any(String) }, completion: 'pull_request' });
});
it('distinguishes saved approval posture and run-effective review mode', async () => {
  persist();
  writeFileSync(join(dataDir, 'settings.toml'), '[review]\nrequire_approval = "always"\n');
  process.env.O8_REVIEW_MODE = 'manual';
  const policy = await (await read()).json();
  expect(policy.approvalPosture).toMatchObject({ value: 'always', precedence: 'saved' });
  expect(policy.reviewMode).toMatchObject({ value: 'manual', precedence: 'run-effective' });
  delete process.env.O8_REVIEW_MODE;
});
it('reports holds and unknown state as human decisions with reasons', async () => {
  persist(true);
  expect((await (await read()).json()).holds.value).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'merge-hold', reason: expect.any(String) })]));
  process.env.O8_REVIEW_MODE = 'invalid';
  expect((await (await read()).json()).nextAction).toMatchObject({ value: 'human', reason: expect.stringContaining('unreadable') });
  delete process.env.O8_REVIEW_MODE;
});
it('refuses packet workers before reading policy', async () => {
  expect((await read(mintPacketWorkerToken('pkt-policy'))).status).toBe(403);
});
it('MCP reads the same persisted result through the authenticated route', async () => {
  persist();
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const { GET } = await import('@/app/api/lanes/[id]/policy/route');
    return GET(new NextRequest(request().url, { headers: init?.headers }), { params: Promise.resolve({ id: lane.id }) });
  });
  const { handleGetEffectivePolicy } = await import('@/lib/mcp/operator-handlers/effective-policy');
  const result = await handleGetEffectivePolicy({ laneId: lane.id });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}')).toMatchObject({ laneId: lane.id, completion: 'pull_request' });
});

it('CLI reads persisted policy through the route and preserves worker refusal', async () => {
  persist();
  process.env.O8_API_TOKEN = getOrCreateWsToken();
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/lanes') return Response.json({ lanes: [lane] });
    const { GET } = await import('@/app/api/lanes/[id]/policy/route');
    return GET(new NextRequest(request().url, { headers: init?.headers }), { params: Promise.resolve({ id: lane.id }) });
  });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const { runPacketPolicy } = await import('../cli/src/commands/packet/policy');
    expect(await runPacketPolicy({ human: false, verbose: false }, [lane.id])).toBe(0);
    expect(output.mock.calls.some(([text]) => String(text).includes('o8/effective-policy/v1'))).toBe(true);
    process.env.O8_WORKER_TOKEN = mintPacketWorkerToken('pkt-policy');
    process.env.O8_WORKER_PACKET_ID = 'pkt-policy';
    await expect(runPacketPolicy({ human: false, verbose: false }, [lane.id])).rejects.toThrow();
  } finally {
    output.mockRestore();
    delete process.env.O8_API_TOKEN;
    delete process.env.O8_WORKER_TOKEN;
    delete process.env.O8_WORKER_PACKET_ID;
  }
});

it('refuses device MCP profiles and reports malformed persisted settings', async () => {
  const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
  const refusal = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'get_effective_policy', arguments: { laneId: lane.id },
  } }, 'devices');
  expect(refusal).toMatchObject({ result: { isError: true } });
  writeFileSync(join(dataDir, 'settings.toml'), '[review]\nrequire_approval = [broken\n');
  const policy = await (await read()).json();
  expect(policy.nextAction).toMatchObject({ value: 'human', reason: expect.stringContaining('unreadable') });
});

it('reports exhausted persisted correction bounds', async () => {
  writeFileSync(join(dataDir, 'settings.toml'), '[review]\nrequire_approval = "always"\n');
  persist(false, 2);
  const policy = await (await read()).json();
  expect(policy.correctionBounds.value).toEqual({ maximum: 2, used: 2 });
  expect(policy.holds.value).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'correction-bounds' })]));
  expect(policy.nextAction.value).toBe('human');
});

it('does not present unreadable legacy settings as an inherited default', async () => {
  writeFileSync(join(dataDir, 'operator-defaults.json'), '{broken');
  const policy = await (await read()).json();
  expect(policy.nextAction).toMatchObject({ value: 'human', reason: expect.stringContaining('unreadable') });
});
