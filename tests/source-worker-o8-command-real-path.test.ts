import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const sandbox = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async (input: { binary: string; args: string[]; finalAllowReadPaths?: string[] }) => {
    sandbox.reads = input.finalAllowReadPaths ?? [];
    return { binary: input.binary, args: input.args };
  },
}));

// Provider readiness is offline; launch, ownership, routes, CLI, and git are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-cli-')));
const repo = join(root, 'repo');
const data = root;
const owned = join(root, 'owned');
const runtime = join(root, 'worker.mjs');
const receipt = join(root, 'receipt.json');
let http: Server;
let worktree: string;
let laneId: string;
let packetId: string;
let sourceBundle: string;
const principals: string[] = [];
const originalPath = process.env.PATH;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeAll(async () => {
  mkdirSync(repo);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', data); vi.stubEnv('O8_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', owned);
  vi.stubEnv('CODEX_HOME', join(root, 'runtime-home'));
  vi.stubEnv('O8_CODEX_BIN', runtime);
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
  vi.stubEnv('O8_PROCESS_SUPERVISOR', '0'); vi.stubEnv('O8_WORKER_SANDBOX', 'off');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'o8-test'); git('config', 'user.email', 'test@o8.invalid');
  writeFileSync(join(repo, 'change.txt'), 'before\n');
  git('add', '--', 'change.txt'); git('commit', '-qm', 'test: initial state');
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  packetId = 'worker-cli-fixture';
  worktree = join(repo, '.cortex-worktrees', `packet-${packetId}`);
  mkdirSync(dirname(worktree), { recursive: true });
  git('worktree', 'add', worktree, '-b', 'task/worker-cli-fixture');
  const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktree);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(dirname(worktree));
  await withWorktreeMetaTransaction(repo, transaction => transaction.save(`packet-${packetId}`, {
    id: `packet-${packetId}`, agentType: 'codex', baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: 'task/worker-cli-fixture', status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
  const packet: OrchestratorPacket = { id: packetId, referenceLabel: 'WORKER', title: 'Worker CLI fixture',
    summary: 'Verify supported packet commands from an owned worker.', workspaceTargetPath: repo,
    branchTarget: 'task/worker-cli-fixture', runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'queued', lane: null };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [packet] });
  const { createLane } = await import('@/lib/lane/registry');
  laneId = createLane({ repoPath: repo, worktreePath: worktree, branch: packet.branchTarget, runtime: 'codex', packetId }).id;
  const { panelGateMiddleware } = await import('@/middleware');
  const { resolveRequestPrincipalContext } = await import('@/lib/auth/principal');
  const lanes = await import('@/app/api/lanes/route');
  const lane = await import('@/app/api/lanes/[id]/route');
  const scope = await import('@/app/api/lanes/[id]/scope/route');
  http = createServer(async (req, res) => {
    try {
      const request = new NextRequest(`http://127.0.0.1${req.url}`, { headers: req.headers as Record<string, string> });
      const gate = panelGateMiddleware(request);
      let response: Response = gate;
      if (gate.headers.get('x-middleware-next') === '1') {
        const principal = resolveRequestPrincipalContext(request);
        if (principal.role === 'worker') principals.push(principal.packetId ?? 'unbound');
        const params = { params: Promise.resolve({ id: laneId }) };
        response = request.nextUrl.pathname === '/api/lanes' ? await lanes.GET(request)
          : request.nextUrl.pathname.endsWith('/scope') ? await scope.GET(request, params)
          : await lane.GET(request, params);
      }
      res.writeHead(response.status); res.end(await response.text());
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  vi.stubEnv('O8_API_PORT', String(port)); writeFileSync(join(data, 'api-port'), String(port));
  writeFileSync(runtime, `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('worker-fixture 1.0.0'); process.exit(0); }
const result = { cwd: process.cwd(), path: process.env.PATH };
try {
  result.info = JSON.parse(execFileSync('o8', ['packet', 'info'], { encoding: 'utf8' }));
  try { execFileSync('o8', ['packet', 'info', 'another-packet'], { stdio: 'pipe' }); result.crossPacketDenied = false; }
  catch { result.crossPacketDenied = true; }
  writeFileSync('change.txt', 'after ' + Date.now() + '\\n');
  result.commit = JSON.parse(execFileSync('o8', ['packet', 'commit', '-m', 'test: scoped worker change'], { encoding: 'utf8' }));
} catch (error) { result.error = error.code || error.message; }
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(result));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  chmodSync(runtime, 0o700);
}, 60000);

afterAll(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  const { closeDb } = await import('@/lib/db'); closeDb();
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function session(surfaceId: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(owned, surfaceId.replace('codex-owned:', ''), 'session.json'), 'utf8'));
}
async function finished(surfaceId: string) {
  const { getOwnedCodexRuntimeTail } = await import('@/lib/codex/owned');
  await vi.waitFor(async () => {
    await getOwnedCodexRuntimeTail(surfaceId);
    expect(session(surfaceId).activeRun).toBeUndefined();
    expect(session(surfaceId).recentRuns[0].childExit?.code).toBe(0);
  }, { timeout: 20000, interval: 50 });
}

describe.skipIf(process.platform === 'win32')('source worker o8 command at the real launch boundary', () => {
  it('runs packet info and scoped packet commit from a persisted owned cwd', async () => {
    const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
    const before = git('rev-parse', 'main');
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet info, then o8 packet commit.',
      packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true);
    await finished(launched.surfaceId);
    const run = session(launched.surfaceId).recentRuns[0];
    sourceBundle = join(dirname(run.stdoutPath), `${run.id}-o8`, 'o8.mjs');
    const verification = JSON.parse(readFileSync(join(dirname(sourceBundle), 'verification.json'), 'utf8'));
    expect(verification).toMatchObject({ source: 'source', verified: true });
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(result.error).toBeUndefined();
    expect(result.cwd).toBe(worktree);
    expect(result.info.schema).toBe('o8/cli/packet.info/v1');
    expect(result.commit).toMatchObject({ schema: 'o8/cli/packet.commit/v1', committed: true });
    expect(result.crossPacketDenied).toBe(true);
    expect(principals.length).toBeGreaterThan(0);
    expect(principals.every(id => id === packetId)).toBe(true);
    expect(git('rev-parse', 'main')).toBe(before);
    expect(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe('change.txt');
    expect(process.env.PATH).toBe(originalPath);
    expect(session(launched.surfaceId)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' });
  }, 60000);

  it('keeps the verified command available through a local execution carrier', async () => {
    const runtimeDir = join(root, 'runtime-bin'); const carrierDir = join(root, 'carrier-bin');
    mkdirSync(runtimeDir); mkdirSync(carrierDir);
    const binary = join(runtimeDir, 'codex'); const carrier = join(carrierDir, 'ori');
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${runtime}' \"$@\"\n`, { mode: 0o700 });
    writeFileSync(carrier, '#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.0.0; exit 0; fi\nshift\nexec codex \"$@\"\n', { mode: 0o700 });
    const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
    vi.stubEnv('O8_CODEX_BIN', binary); vi.stubEnv('O8_ORI_BIN', carrier); invalidateCliCache('codex');
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high', executionCarrier: 'ori' });
      expect(launched.ok).toBe(true); await finished(launched.surfaceId);
      expect(session(launched.surfaceId).recentRuns[0].commandIdentity).toBe(carrier);
      expect(session(launched.surfaceId).runtimeConfig?.executionCarrier).toBe('ori');
      expect(JSON.parse(readFileSync(receipt, 'utf8')).commit.committed).toBe(true);
    } finally { vi.stubEnv('O8_CODEX_BIN', runtime); vi.stubEnv('O8_ORI_BIN', ''); invalidateCliCache('codex'); }
  }, 60000);

  it('regrants only verified CLI files after sandbox secret denials', async () => {
    vi.stubEnv('O8_WORKER_SANDBOX', '1');
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      expect(launched.ok).toBe(true); await finished(launched.surfaceId);
      const run = session(launched.surfaceId).recentRuns[0];
      const binDir = join(dirname(run.stdoutPath), `${run.id}-o8`);
      expect(sandbox.reads).toEqual(expect.arrayContaining([join(binDir, 'o8'), join(binDir, 'o8.mjs')]));
      expect(sandbox.reads).not.toContain(root);
      expect(sandbox.reads).not.toContain(session(launched.surfaceId).sessionDir);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).commit.committed).toBe(true);
    } finally { vi.stubEnv('O8_WORKER_SANDBOX', 'off'); }
  }, 60000);

  it('launches with the current packaged CLI through the same worker boundary', async () => {
    const bundled = join(root, 'packaged-current'); mkdirSync(join(bundled, 'bin'), { recursive: true });
    cpSync(sourceBundle, join(bundled, 'bin', 'o8.mjs'));
    vi.stubEnv('O8_PACKAGED_APP', '1'); vi.stubEnv('O8_BUNDLED_MCP_DIR', bundled);
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      expect(launched.ok).toBe(true); await finished(launched.surfaceId);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).commit.committed).toBe(true);
    } finally { vi.stubEnv('O8_PACKAGED_APP', ''); vi.stubEnv('O8_BUNDLED_MCP_DIR', ''); }
  }, 60000);

  it.each(['missing', 'incompatible', 'stale'])('holds a %s packaged CLI before the provider starts', async mode => {
    rmSync(receipt, { force: true });
    const bundled = join(root, `packaged-${mode}`); mkdirSync(join(bundled, 'bin'), { recursive: true });
    if (mode === 'incompatible') writeFileSync(join(bundled, 'bin', 'o8.mjs'), "console.log('unrelated command')");
    if (mode === 'stale') writeFileSync(join(bundled, 'bin', 'o8.mjs'), `console.log(process.argv.includes('--help') ? 'packet info, packet commit' : JSON.stringify({schema:'o8/cli/version/v1',cliVersion:'0.0.0-stale'}));`);
    vi.stubEnv('O8_PACKAGED_APP', '1'); vi.stubEnv('O8_BUNDLED_MCP_DIR', bundled);
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet info.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      if (launched.ok) await finished(launched.surfaceId);
      expect(launched.ok).toBe(false);
      expect(launched.note).toContain('o8_cli_unavailable');
      expect(session(launched.surfaceId).recentRuns[0]).toMatchObject({ outcome: 'failed', pid: 0 });
      expect(readdirSync(root)).not.toContain('receipt.json');
    } finally { vi.stubEnv('O8_PACKAGED_APP', ''); vi.stubEnv('O8_BUNDLED_MCP_DIR', ''); }
  }, 60000);
});
