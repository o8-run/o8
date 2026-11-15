import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes', async () => {
  const { piRuntime } = await import('@/lib/runtimes/pi');
  return { getAllRuntimes: () => [piRuntime], getRuntime: () => piRuntime };
});
vi.mock('@/lib/pi/user-setup', async (original) => ({
  ...await original<typeof import('@/lib/pi/user-setup')>(),
  listUserPiSessions: async () => [],
}));
vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({ sweepOrphanedOwnedSessions: async () => {} }));

const { GET } = await import('@/app/api/operator/status/route');
const { GET: approvalsGET } = await import('@/app/api/panel/approvals/route');
const { handleStatus } = await import('@/lib/mcp/operator-handlers/status');
const { GET: leadGET } = await import('@/lib/orchestrator/http/lead');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { runStatus } = await import('../cli/src/commands/status');
const { createLane, listLanes } = await import('@/lib/lane/registry');
const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');
const { approvalAge } = await import('@/lib/orchestrator/status-age');
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const root = process.env.O8_OWNED_PI_ROOT!;
const now = Date.now();
const day = 86_400_000;
let base: string;
let approvalId: string;
const records = new Map<string, string>();
const server = createServer((request, response) => {
  const url = new URL(request.url!, base);
  const headers = { authorization: `Bearer ${getOrCreateWsToken()}` };
  const req = new NextRequest(url, { headers });
  const result = url.pathname === '/api/operator/status' ? GET(req)
    : url.pathname === '/api/orchestrator/lead' ? leadGET(req)
    : url.pathname === '/api/panel/approvals' ? approvalsGET(req)
      : Promise.resolve(Response.json(url.pathname === '/api/lanes'
        ? { lanes: listLanes().filter((lane) => url.searchParams.get('active') === 'false' || lane.status === 'running') }
        : {}));
  void result.then(async (res) => {
    response.writeHead(res.status, { 'content-type': 'application/json' });
    response.end(await res.text());
  }).catch((error) => response.writeHead(500).end(String(error)));
});

function saveSession(id: string, age: number, pid?: number) {
  const sessionDir = join(root, id);
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date(now - age).toISOString();
  const run = { id: 'run', mode: 'launch', prompt: 'Check status', startedAt: timestamp,
    outcome: 'running', pid, stdoutPath: join(sessionDir, 'run.jsonl'), stderrPath: join(sessionDir, 'stderr.log') };
  writeFileSync(run.stdoutPath, '');
  const file = join(sessionDir, 'session.json');
  const bytes = JSON.stringify({ surfaceId: `pi-owned:${id}`, sessionDir, cwd: dataDir, repoPath: dataDir,
    title: id, createdAt: timestamp, updatedAt: id === 'dead' ? new Date(now).toISOString() : timestamp, latestPrompt: 'Check status',
    latestSummary: 'Working', activeRun: run, recentRuns: [run] });
  writeFileSync(file, bytes);
  records.set(file, bytes);
  return `pi-owned:${id}`;
}

beforeAll(async () => {
  // No process can have this PID on supported hosts; signal zero only probes it.
  saveSession('dead', 7 * day, 2_147_483_647);
  saveSession('fresh', 60_000, 2_147_483_647);
  saveSession('live', 7 * day, process.pid);
  saveSession('unknown', 7 * day);
  saveSession('runtime-only', 7 * day, 2_147_483_647);
  saveSession('recent-log', 7 * day, 2_147_483_647);
  writeFileSync(join(root, 'recent-log', 'run.jsonl'), '{"type":"agent_start"}\n');
  const lane = createLane({ repoPath: dataDir, branch: 'fixture', baseBranch: 'main', runtime: 'pi',
    label: 'Dead worker', packetId: 'pkt-dead', sessionKey: 'pi-owned:dead' });
  getSqlite().prepare("UPDATE lanes SET status = 'running', last_event_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date(now - 7 * day).toISOString(), new Date(now - 7 * day).toISOString(), lane.id);
  const retired = createLane({ repoPath: dataDir, branch: 'retired', runtime: 'pi',
    packetId: 'pkt-retired', sessionKey: 'pi-owned:runtime-only' });
  getSqlite().prepare("UPDATE lanes SET status = 'archived', last_event_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date(now - 7 * day).toISOString(), new Date(now - 7 * day).toISOString(), retired.id);
  const review = createLane({ repoPath: dataDir, branch: 'review', baseBranch: 'main', runtime: 'pi',
    label: 'Awaiting review', packetId: 'pkt-review', sessionKey: 'pi-owned:review' });
  getSqlite().prepare("UPDATE lanes SET status = 'reviewing' WHERE id = ?").run(review.id);
  const approval = createApproval({ source: 'test', runtime: 'pi', agent: 'fixture',
    title: 'Review decision', description: 'Review decision', summary: 'Review decision',
    sessionKey: 'pi-owned:review', risk: 'medium',
    args: { approvalRoute: 'dispatcher', dispatcherSurface: 'operator' }, metadata: { Lane: review.id } });
  approvalId = approval.id;
  getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(now - 15 * day, approvalId);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  base = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(dataDir, 'api-port'), String(address.port));
  setApiBase(base);
  vi.stubEnv('O8_API_PORT', String(address.port));
  vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  vi.stubEnv('O8_WORKER_TOKEN', '');
  invalidateRuntimeInventoryCache();
});
afterEach(() => { vi.restoreAllMocks(); invalidateRuntimeInventoryCache(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('status freshness through persisted runtime and approval state (#4072)', () => {
  it('reports a processless old run as stale through o8_status with a recovery action', async () => {
    const result = await handleStatus({ sessionKey: 'pi-owned:dead' });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.data.agents).toEqual([expect.objectContaining({ status: 'stale',
      sessionKey: 'pi-owned:dead', summary: expect.stringContaining('no live process'),
      nextActions: [expect.objectContaining({ action: 'steer', endpoint: '/api/runtime/action',
        surfaceId: 'pi-owned:dead', requiredInputs: ['message', 'clientMutationId'] })] })]);
    expect(payload.summary).toContain('0 agents running');
    expect(payload.summary).toContain('1 needs attention');
  });

  it('keeps fresh, live, and uncertain process evidence out of stale rows', async () => {
    const response = await GET(new NextRequest(`${base}/api/operator/status`));
    expect(response.status).toBe(200);
    const payload = await response.json();
    for (const id of ['fresh', 'live', 'unknown', 'recent-log']) {
      expect(payload.agents.find((agent: { sessionKey: string }) => agent.sessionKey === `pi-owned:${id}`)?.status).toBe('running');
    }
    for (const [file, bytes] of records) expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('also marks the persisted lane fallback stale during a runtime discovery gap', async () => {
    const { piRuntime } = await import('@/lib/runtimes/pi');
    vi.spyOn(piRuntime, 'discoverSessions').mockResolvedValue([]);
    invalidateRuntimeInventoryCache();
    const response = await GET(new NextRequest(`${base}/api/operator/status?sessionKey=pi-owned:dead`));
    expect(response.status).toBe(200);
    expect((await response.json()).agents).toEqual([expect.objectContaining({
      sessionKey: 'pi-owned:dead', status: 'stale', authority: 'lane-state',
    })]);
  });

  it('shows the persisted pending approval age and overdue flag through MCP', async () => {
    const result = await handleStatus({});
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.data.approvals).toContainEqual(expect.objectContaining({ id: approvalId,
      ageMs: expect.any(Number), age: '15d', overdue: true, thresholdMs: 86_400_000 }));
    expect(getApproval(approvalId)?.status).toBe('pending');
  });

  it('reports stale runtime sessions and excludes their lanes from CLI running counts', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runStatus({ human: false, verbose: false })).toBe(0);
    const payload = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(payload.counts.runningPackets).toBe(0);
    expect(payload.staleSessions).toContainEqual(expect.objectContaining({ sessionKey: 'pi-owned:dead', status: 'stale' }));
    expect(payload.staleSessions).toContainEqual(expect.objectContaining({ sessionKey: 'pi-owned:runtime-only', status: 'stale' }));
    expect(payload.pendingApprovals).toContainEqual(expect.objectContaining({ id: approvalId, age: '15d', overdue: true }));
  });

  it('prints stale recovery guidance and approval age in human CLI output', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runStatus({ human: true, verbose: false });
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(text).toContain('pi-owned:dead');
    expect(text).toContain('/api/runtime/action');
    expect(text).toContain('15d [overdue]');
  });

  it('handles numeric, ISO, future, missing and invalid approval times at the warning boundary', () => {
    expect(approvalAge(now - day, now)).toMatchObject({ age: '1d', overdue: true });
    expect(approvalAge(new Date(now - day + 1).toISOString(), now).overdue).toBe(false);
    expect(approvalAge(now + day, now)).toMatchObject({ ageMs: 0, overdue: false });
    for (const value of [undefined, null, 'invalid']) {
      expect(approvalAge(value, now)).toMatchObject({ ageMs: null, age: 'unknown', overdue: false });
    }
  });

  it.each(['EPERM', 'EACCES'])('does not infer death from an uncertain %s process probe', async (code) => {
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 2_147_483_647) throw Object.assign(new Error('Fixture probe refused'), { code });
      return kill(pid, signal);
    });
    const response = await GET(new NextRequest(`${base}/api/operator/status?sessionKey=pi-owned:dead`));
    expect((await response.json()).agents[0].status).toBe('running');
  });

  it.skipIf(process.platform === 'win32')('recovers using the offered runtime action and persists a new run', async () => {
    const executable = join(dataDir, 'fixture-pi.mjs');
    writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('1.1.0'); process.exit(0); }\nprocess.stdin.once('data', () => { process.stdout.write('{"type":"agent_end"}\\n'); setTimeout(() => process.exit(0), 50); });\n`, { mode: 0o755 });
    vi.stubEnv('O8_PI_BIN', executable);
    const response = await GET(new NextRequest(`${base}/api/operator/status?sessionKey=pi-owned:runtime-only`));
    const descriptor = (await response.json()).agents[0].nextActions[0];
    const { POST } = await import('@/app/api/runtime/action/route');
    const result = await POST(new NextRequest(`${base}${descriptor.endpoint}`, { method: descriptor.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: descriptor.action, surfaceId: descriptor.surfaceId,
        message: 'Resume the fixture task', clientMutationId: 'fixture-recover-status' }) }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(root, 'runtime-only', 'session.json'), 'utf8'));
      expect(record.recentRuns[0]).toMatchObject({ mode: 'resume', prompt: 'Resume the fixture task', outcome: 'finished' });
      expect(record.activeRun).toBeUndefined();
      expect(record.rpcPid).toBeUndefined();
    });
    invalidateRuntimeInventoryCache();
    const recovered = await GET(new NextRequest(`${base}/api/operator/status?sessionKey=pi-owned:runtime-only`));
    expect((await recovered.json()).agents[0]?.status).not.toBe('stale');
  });
});
