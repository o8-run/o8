import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

// Retirement is exercised separately; keep these retained fixtures on disk.
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));

const root = mkdtempSync(path.join(tmpdir(), 'o8-terminal-storage-'));
const data = path.join(root, 'data');
mkdirSync(data);
const token = 'terminal-storage-fixture-token';
writeFileSync(path.join(data, 'ws-token'), token);
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
const { closeDb } = await import('@/lib/db');
const { createLane, appendEvent, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const lanesRoute = await import('@/app/api/lanes/route');
let server: Server;
let port: number;
const bundle = path.join(root, 'o8.mjs');

function lane(id: string, status: 'completed' | 'archived' | 'failed' | 'running', options: {
  ownership?: 'managed' | 'attached'; packetId?: string | null; worktreePath?: string; file?: boolean;
} = {}) {
  const worktreePath = options.worktreePath ?? path.join(root, id);
  if (!options.worktreePath) {
    if (options.file) writeFileSync(worktreePath, 'not a directory');
    else {
      mkdirSync(worktreePath);
      writeFileSync(path.join(worktreePath, 'retained.bin'), Buffer.alloc(8192, 1));
    }
  }
  const created = createLane({ repoPath: root, worktreePath, branch: 'fixture/' + id,
    baseBranch: 'main', runtime: 'codex', packetId: options.packetId === null ? undefined : options.packetId ?? id,
    ownership: options.ownership ?? 'managed' });
  setLaneStatus(created.id, status);
  return { ...created, status, worktreePath };
}

function cli(human = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...(human ? ['--human'] : []), 'status'], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: '', O8_API_PORT: String(port), O8_API_TOKEN: token,
        O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  await build({ alias: cliBundleAlias, entryPoints: ['cli/src/index.ts'], outfile: bundle, bundle: true, platform: 'node',
    format: 'esm', target: 'node22', define: { __O8_CLI_VERSION__: JSON.stringify('fixture') },
    banner: { js: "import { createRequire as __fixtureCreateRequire } from 'node:module'; const require = __fixtureCreateRequire(import.meta.url);" } });
  server = createServer(async (request, response) => {
    try {
      const req = new NextRequest(new URL(request.url ?? '/', 'http://127.0.0.1:' + port), {
        headers: request.headers as HeadersInit,
      });
      const result = req.nextUrl.pathname === '/api/lanes' ? await lanesRoute.GET(req)
        : Response.json(req.nextUrl.pathname === '/api/setup/status' ? { setupComplete: true } : {});
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  port = address.port;
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('terminal checkout storage through status', () => {
  it('reports unique retained managed checkouts and their recorded refusal through the built CLI', async () => {
    const retained = ['completed', 'archived', 'failed'].map(status => lane('retained-' + status,
      status as 'completed' | 'archived' | 'failed'));
    appendEvent(retained[1].id, 'update', 'system', {
      phase: 'archive_cleanup_held', reason: 'retirement-refused', detail: 'Fixture checkout has a live holder.',
    });
    lane('duplicate', 'archived', { worktreePath: retained[0].worktreePath });
    lane('active', 'running');
    lane('attached', 'archived', { ownership: 'attached' });
    lane('without-packet', 'completed', { packetId: null });
    lane('main-checkout', 'completed', { worktreePath: root });
    lane('already-removed', 'archived', { worktreePath: path.join(root, 'absent') });
    const expectedBytes = retained.reduce((sum, item) => sum + Number(execFileSync('du',
      process.platform === 'darwin' ? ['-sk', item.worktreePath] : ['-s', '--block-size=1', item.worktreePath],
      { encoding: 'utf8' }).trim().split(/\s+/)[0]) * (process.platform === 'darwin' ? 1024 : 1), 0);

    const ordinary = await lanesRoute.GET(new NextRequest('http://localhost/api/lanes?active=false', {
      headers: { authorization: 'Bearer ' + token },
    }));
    expect(await ordinary.json()).not.toHaveProperty('terminalStorage');
    const result = await cli();
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout).terminalStorage;
    expect(summary).toMatchObject({ accountingStatus: 'observed', checkoutCount: 3,
      allocatedBytes: expectedBytes, observedAllocatedBytes: expectedBytes, unknownCheckouts: 0 });
    expect(summary.checkouts).toHaveLength(3);
    expect(summary.checkouts).toContainEqual(expect.objectContaining({
      packetId: 'retained-archived', reason: 'retirement-refused', detail: 'Fixture checkout has a live holder.',
    }));
    const human = await cli(true);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('terminal checkout storage');
    expect(human.stdout).toContain(`${expectedBytes} allocated bytes`);
    expect(human.stdout).toContain('Fixture checkout has a live holder.');
  }, 30_000);

  it('keeps failed accounting unknown and excludes checkouts after their paths are cleared', async () => {
    const unknown = lane('unknown-storage', 'archived', { file: true });
    const result = await cli();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).terminalStorage).toMatchObject({ accountingStatus: 'partial',
      allocatedBytes: null, unknownCheckouts: 1, checkoutCount: 4 });
    const human = await cli(true);
    expect(human.stdout).toContain('allocated bytes unknown');
    updateLane(unknown.id, { worktreePath: null });
    expect(JSON.parse((await cli()).stdout).terminalStorage).toMatchObject({
      accountingStatus: 'observed', checkoutCount: 3, unknownCheckouts: 0,
    });
  }, 30_000);

  it('measures only the caller-visible packet lanes and rejects an unauthenticated request', async () => {
    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const bearer = mintPacketWorkerToken('retained-archived');
    const response = await lanesRoute.GET(new NextRequest('http://localhost/api/lanes?active=false&storage=terminal', {
      headers: { authorization: 'Bearer ' + bearer, host: 'localhost' },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.terminalStorage).toMatchObject({ checkoutCount: 1, accountingStatus: 'observed' });
    expect(body.terminalStorage.checkouts.map((item: { packetId: string }) => item.packetId))
      .toEqual(['retained-archived']);
    const denied = await lanesRoute.GET(new NextRequest('http://localhost/api/lanes?active=false&storage=terminal'));
    expect(denied.status).toBe(401);
  });

  it('returns unknown totals within the status budget when filesystem measurements stall', async () => {
    const telemetry = await import('@/lib/worktree/storage-telemetry');
    let release!: (value: Awaited<ReturnType<typeof telemetry.refreshDirectoryStorage>>) => void;
    const held = new Promise<Awaited<ReturnType<typeof telemetry.refreshDirectoryStorage>>>(resolve => { release = resolve; });
    const measure = vi.spyOn(telemetry, 'refreshDirectoryStorage').mockReturnValue(held);
    vi.useFakeTimers();
    let settled = false;
    const request = lanesRoute.GET(new NextRequest('http://localhost/api/lanes?active=false&storage=terminal', {
      headers: { authorization: 'Bearer ' + token },
    })).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      const response = await request;
      expect(response.status).toBe(200);
      expect((await response.json()).terminalStorage).toMatchObject({
        allocatedBytes: null, observedAllocatedBytes: 0,
      });
      expect(measure.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      release({ path: root, category: 'workspace', presence: 'unknown', count: null,
        allocatedBytes: null, logicalBytes: null, countAccounting: 'unknown',
        allocatedBytesAccounting: 'unknown', logicalBytesAccounting: 'unknown', errors: [] });
      await request;
      vi.useRealTimers();
      measure.mockRestore();
    }
  });
});
