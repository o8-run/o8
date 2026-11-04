import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, truncateSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const sandbox = vi.hoisted(() => ({ reads: [] as string[], immutable: [] as string[], ancestors: [] as string[], beforeDispatch: undefined as (() => void) | undefined }));
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async (input: { binary: string; args: string[]; finalAllowReadPaths?: string[]; finalImmutableWritePaths?: string[]; finalImmutableAncestorPaths?: string[] }) => {
    sandbox.reads = input.finalAllowReadPaths ?? [];
    sandbox.immutable = input.finalImmutableWritePaths ?? [];
    sandbox.ancestors = input.finalImmutableAncestorPaths ?? [];
    return { binary: input.binary, args: input.args };
  },
}));

// Provider readiness is offline; launch, ownership, routes, CLI, and git are real.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => { sandbox.beforeDispatch?.(); return { ready: true }; }),
}));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-cli-')));
const data = join(root, 'data');
const repo = join(data, 'repo');
const writableTmp = join(root, 'worker-tmp');
const owned = join(writableTmp, 'owned');
const runtime = join(root, 'worker.mjs');
const receipt = join(root, 'receipt.json');
let http: Server;
let worktree: string;
let laneId: string;
let packetId: string;
const sourceBundle = join(root, 'source-cli.mjs');
const principals: string[] = [];
const originalPath = process.env.PATH;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeAll(async () => {
  mkdirSync(data); mkdirSync(repo); mkdirSync(writableTmp);
  execFileSync(process.execPath, ['cli/esbuild.config.mjs', '--worker-output', sourceBundle], { cwd: process.cwd(), stdio: 'pipe' });
  vi.stubEnv('TMPDIR', writableTmp);
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
import { readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('worker-fixture 1.0.0'); process.exit(0); }
const result = { cwd: process.cwd(), path: process.env.PATH, verification: JSON.parse(readFileSync(process.env.PATH.split(':')[0] + '/verification.json', 'utf8')) };
try {
  result.info = JSON.parse(execFileSync('o8', ['packet', 'info'], { encoding: 'utf8' }));
  try { execFileSync('o8', ['packet', 'info', 'another-packet'], { stdio: 'pipe' }); result.crossPacketDenied = false; }
  catch { result.crossPacketDenied = true; }
  writeFileSync('change.txt', 'after ' + Date.now() + '\\n');
  result.commit = JSON.parse(execFileSync('o8', ['packet', 'commit', '-m', 'test: scoped worker change'], { encoding: 'utf8' }));
} catch (error) { result.error = error.code || error.message; }
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(result));
if (process.argv.some(arg => arg.includes('hold-cli'))) await new Promise(resolve => { const timer = setTimeout(resolve, 20000); process.once('SIGINT', () => { clearTimeout(timer); resolve(); }); });
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
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(existsSync(result.path.split(':')[0])).toBe(false);
    expect(result.verification).toMatchObject({ source: 'source', verified: true });
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
      const binDir = JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0];
      expect(sandbox.reads).toEqual(expect.arrayContaining([join(binDir, 'o8'), join(binDir, 'o8.mjs')]));
      expect(sandbox.immutable).toContain(join(data, 'worker-cli'));
      expect(sandbox.ancestors).toEqual(expect.arrayContaining([data, root, dirname(root), '/']));
      expect(sandbox.reads).not.toContain(root);
      expect(sandbox.reads).not.toContain(session(launched.surfaceId).sessionDir);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).commit.committed).toBe(true);
    } finally { vi.stubEnv('O8_WORKER_SANDBOX', 'off'); }
  }, 60000);

  it.each(['rewrite', 'symlink', 'entry rewrite', 'ancestor symlink', 'receipt rewrite'] as const)('holds a post-verification %s of the CLI before worker launch', async mutation => {
    rmSync(receipt, { force: true });
    vi.stubEnv('O8_WORKER_SANDBOX', '1');
    let changedBundle = '';
    let restore = () => {};
    sandbox.beforeDispatch = () => {
      changedBundle = sandbox.reads.find(file => file.endsWith('/o8.mjs'))!;
      expect(changedBundle).toBeTruthy();
      if (mutation.endsWith('rewrite')) {
        const target = mutation === 'entry rewrite' ? join(dirname(changedBundle), 'o8')
          : mutation === 'receipt rewrite' ? join(dirname(changedBundle), 'verification.json') : changedBundle;
        const original = readFileSync(target);
        restore = () => writeFileSync(target, original);
        writeFileSync(target, '\n/* changed after verification */\n', { flag: 'a' });
      }
      else if (mutation === 'ancestor symlink') {
        const replacement = join(writableTmp, 'replacement-directory');
        renameSync(dirname(changedBundle), replacement); symlinkSync(replacement, dirname(changedBundle), 'dir');
        restore = () => { rmSync(dirname(changedBundle)); renameSync(replacement, dirname(changedBundle)); };
      } else {
        const replacement = join(writableTmp, 'replacement.mjs');
        cpSync(changedBundle, replacement);
        rmSync(changedBundle); symlinkSync(replacement, changedBundle);
        restore = () => { rmSync(changedBundle); cpSync(replacement, changedBundle); };
      }
    };
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet info.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      if (launched.ok) await finished(launched.surfaceId);
      expect(launched.ok).toBe(false);
      expect(launched.note).toContain('o8_cli_unavailable');
      const persisted = session(launched.surfaceId);
      expect(persisted.recentRuns[0]).toMatchObject({ outcome: 'failed', pid: 0 });
      expect(persisted.recentRuns.filter(run => run.id === persisted.recentRuns[0].id)).toHaveLength(1);
      expect(readdirSync(root)).not.toContain('receipt.json');
      expect(changedBundle.startsWith(data + '/')).toBe(true);
      expect(changedBundle.startsWith(writableTmp + '/')).toBe(false);
      expect(sandbox.immutable).toContain(join(data, 'worker-cli'));
    } finally { sandbox.beforeDispatch = undefined; if (existsSync(dirname(changedBundle))) restore(); vi.stubEnv('O8_WORKER_SANDBOX', 'off'); }
  }, 60000);

  it('holds a symlink in the protected CLI storage path before preparing an entry', async () => {
    rmSync(receipt, { force: true });
    const cliRoot = join(data, 'worker-cli');
    const saved = join(data, 'worker-cli-saved');
    if (readdirSync(data).includes('worker-cli')) renameSync(cliRoot, saved);
    const redirected = join(writableTmp, 'redirected'); mkdirSync(redirected);
    symlinkSync(redirected, cliRoot, 'dir');
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet info.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      if (launched.ok) await finished(launched.surfaceId);
      expect(launched.ok).toBe(false);
      expect(launched.note).toMatch(/o8_cli_unavailable|artifact admission/i);
      expect(readdirSync(redirected)).toEqual([]);
      expect(readdirSync(root)).not.toContain('receipt.json');
    } finally {
      rmSync(cliRoot); if (readdirSync(data).includes('worker-cli-saved')) renameSync(saved, cliRoot);
    }
  }, 60000);

  it.each(['temporary', 'protected'])('counts protected CLI bytes in the real launch budget with %s session storage', async layout => {
    const { codexOwnedAdapter } = await import('@/lib/codex/owned');
    const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
    const { OWNED_ARTIFACT_POLICY } = await import('@/lib/runtimes/shared/owned-session/artifact-admission');
    const sessionRoot = join(layout === 'protected' ? data : writableTmp, `budget-${layout}`);
    const store = createOwnedSessionStore({ ...codexOwnedAdapter, rootEnvVar: 'O8_UNUSED_FIXTURE_ROOT', rootDefault: sessionRoot,
      surfaceIdPrefix: `budget-${layout}:`, sessionIdPrefix: 'budget-' });
    const cliRoot = join(data, 'worker-cli'); mkdirSync(cliRoot, { recursive: true });
    const quota = join(cliRoot, 'quota-probe'); writeFileSync(quota, ''); truncateSync(quota, OWNED_ARTIFACT_POLICY.maxBytes);
    rmSync(receipt, { force: true });
    try {
      const launched = await store.launch({ cwd: worktree, prompt: 'Use o8 packet info.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      if (launched.ok) await vi.waitFor(async () => {
        await store.getRuntimeTail(launched.surfaceId);
        const saved = JSON.parse(readFileSync(join(sessionRoot, launched.surfaceId.split(':')[1], 'session.json'), 'utf8'));
        expect(saved.activeRun).toBeUndefined();
      }, { timeout: 20000 });
      expect(launched.ok).toBe(false); expect(launched.note).toContain('4 GiB');
      expect(existsSync(receipt)).toBe(false);
    } finally { rmSync(quota, { force: true }); }
  }, 60000);

  it('holds bytes added during CLI verification before publishing a worker', async () => {
    const bundled = join(root, 'packaged-growing'); mkdirSync(join(bundled, 'bin'), { recursive: true });
    const quota = join(data, 'worker-cli', 'verification-quota');
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    writeFileSync(join(bundled, 'bin', 'o8.mjs'), `import { writeFileSync, truncateSync } from 'node:fs';
if (process.argv.includes('--help')) { writeFileSync(${JSON.stringify(quota)}, ''); truncateSync(${JSON.stringify(quota)}, 4 * 1024 ** 3); console.log('packet info, packet commit'); }
else console.log(JSON.stringify({schema:'o8/cli/version/v1', cliVersion:${JSON.stringify(version)}}));`);
    vi.stubEnv('O8_PACKAGED_APP', '1'); vi.stubEnv('O8_BUNDLED_MCP_DIR', bundled); rmSync(receipt, { force: true });
    try {
      const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
      const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet info.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
      if (launched.ok) await finished(launched.surfaceId);
      expect(launched.ok).toBe(false); expect(launched.note).toContain('4 GiB');
      expect(existsSync(receipt)).toBe(false);
    } finally { rmSync(quota, { force: true }); vi.stubEnv('O8_PACKAGED_APP', ''); vi.stubEnv('O8_BUNDLED_MCP_DIR', ''); }
  }, 60000);

  it('replaces the same session CLI slot on resume and removes it after confirmed exit', async () => {
    const { launchOwnedCodexSession, continueOwnedCodexSession, archiveOwnedCodexSession } = await import('@/lib/codex/owned');
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true); await finished(launched.surfaceId);
    const firstBin = JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0];
    expect(existsSync(firstBin)).toBe(false);
    for (let turn = 0; turn < 2; turn++) {
      expect((await continueOwnedCodexSession(launched.surfaceId, 'Use o8 packet commands.')).ok).toBe(true);
      await finished(launched.surfaceId);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0]).toBe(firstBin);
      expect(existsSync(firstBin)).toBe(false);
    }
    expect((await archiveOwnedCodexSession(launched.surfaceId)).archived).toBe(true);
    expect(existsSync(firstBin)).toBe(false);
  }, 60000);

  it('reuses identical CLI bytes while a previous process tree remains unconfirmed', async () => {
    const { launchOwnedCodexSession, continueOwnedCodexSession, getOwnedCodexRuntimeTail } = await import('@/lib/codex/owned');
    const { getSqlite } = await import('@/lib/db');
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true);
    const run = session(launched.surfaceId).recentRuns[0];
    // Missing process-group proof models platforms where natural exit cannot prove descendants stopped.
    getSqlite().prepare('UPDATE worker_tokens SET lease_process_group_id = NULL WHERE lease_process_marker = ?').run(run.id);
    await finished(launched.surfaceId);
    const bin = JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0];
    expect(existsSync(bin)).toBe(true); const before = statSync(join(bin, 'o8.mjs')).ino;
    try {
      vi.stubEnv('O8_WORKER_SANDBOX', '1');
      expect((await continueOwnedCodexSession(launched.surfaceId, 'Use o8 packet commands.')).ok).toBe(true);
      await finished(launched.surfaceId);
      expect(JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0]).toBe(bin);
      expect(statSync(join(bin, 'o8.mjs')).ino).toBe(before);
      expect(sandbox.reads).toContain(join(bin, 'o8.mjs'));
      expect(sandbox.reads.some(file => file.includes('.verify-'))).toBe(false);
      expect(readdirSync(join(bin, 'owners')).filter(name => name.endsWith('.json'))).toHaveLength(2);
      expect(readdirSync(join(data, 'worker-cli')).some(name => name.startsWith('.verify-'))).toBe(false);
      const bundled = join(root, 'packaged-changed'); mkdirSync(join(bundled, 'bin'), { recursive: true });
      writeFileSync(join(bundled, 'bin', 'o8.mjs'), 'console.log("changed current source")');
      vi.stubEnv('O8_PACKAGED_APP', '1'); vi.stubEnv('O8_BUNDLED_MCP_DIR', bundled); rmSync(receipt, { force: true });
      const held = await continueOwnedCodexSession(launched.surfaceId, 'Use o8 packet commands.');
      expect(held.ok).toBe(false); expect(held.note).toContain('Previous CLI owners remain unconfirmed');
      expect(statSync(join(bin, 'o8.mjs')).ino).toBe(before); expect(existsSync(receipt)).toBe(false);
      expect(readdirSync(join(data, 'worker-cli')).some(name => name.startsWith('.verify-'))).toBe(false);
      const { cleanupWorkerO8Cli, recordWorkerO8CliStop } = await import('@/lib/runtimes/shared/owned-session/worker-o8-cli-cleanup');
      const saved = session(launched.surfaceId);
      expect(await cleanupWorkerO8Cli(owned, saved, undefined, 'win32')).toBe(false);
      const references = readdirSync(join(bin, 'owners')).filter(name => name.endsWith('.json'));
      for (const reference of references) {
        const owner = JSON.parse(readFileSync(join(bin, 'owners', reference), 'utf8'));
        const lease = getSqlite().prepare('SELECT lease_process_pid AS pid FROM worker_tokens WHERE lease_process_marker = ?').get(owner.runId) as { pid: number };
        await recordWorkerO8CliStop(owned, saved, owner.runId, lease.pid);
      }
      expect(await cleanupWorkerO8Cli(owned, saved, undefined, 'win32')).toBe(true);
    } finally {
      vi.stubEnv('O8_PACKAGED_APP', ''); vi.stubEnv('O8_BUNDLED_MCP_DIR', '');
      vi.stubEnv('O8_WORKER_SANDBOX', 'off');
      getSqlite().prepare('UPDATE worker_tokens SET lease_process_group_id = ? WHERE lease_process_marker = ?').run(run.processGroupId!, run.id);
      await getOwnedCodexRuntimeTail(launched.surfaceId);
    }
    expect(existsSync(bin)).toBe(false);
  }, 60000);

  it('keeps a live owner immutable through archive and cleans it after exit even at full budget', async () => {
    const { launchOwnedCodexSession, archiveOwnedCodexSession, continueOwnedCodexSession } = await import('@/lib/codex/owned');
    rmSync(receipt, { force: true });
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands, hold-cli.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true);
    await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 20000 });
    const saved = session(launched.surfaceId); const run = saved.recentRuns[0];
    const bin = JSON.parse(readFileSync(receipt, 'utf8')).path.split(':')[0];
    // Mutable session labels and PIDs cannot override the protected lease's live process binding.
    saved.activeRun = undefined; saved.recentRuns[0] = { ...run, pid: 0, outcome: 'finished', finishedAt: new Date().toISOString() };
    writeFileSync(join(saved.sessionDir, 'session.json'), JSON.stringify(saved));
    const quota = join(data, 'worker-cli', 'archive-quota'); writeFileSync(quota, ''); truncateSync(quota, 4 * 1024 ** 3);
    try {
      const archived = await archiveOwnedCodexSession(launched.surfaceId);
      expect(archived.archived).toBe(true); expect(existsSync(bin)).toBe(true);
      process.kill(-run.processGroupId!, 'SIGINT');
      await vi.waitFor(() => {
        const ended = JSON.parse(readFileSync(join(archived.archivePath!, 'session.json'), 'utf8'));
        expect(ended.recentRuns[0].childExit).toBeDefined(); expect(existsSync(bin)).toBe(false);
      }, { timeout: 15000 });
      expect(existsSync(quota)).toBe(true);
      const archivedRecord = JSON.parse(readFileSync(join(archived.archivePath!, 'session.json'), 'utf8'));
      expect(archivedRecord.recentRuns[0].stdoutPath).toBe(run.stdoutPath);
      rmSync(quota);
      expect((await continueOwnedCodexSession(launched.surfaceId, 'Use o8 packet commands.')).ok).toBe(true);
      await finished(launched.surfaceId);
      expect(readFileSync(session(launched.surfaceId).recentRuns.find(entry => entry.id === run.id)!.stdoutPath, 'utf8')).toContain('thread.started');
    } finally {
      rmSync(quota, { force: true });
      try { process.kill(-run.processGroupId!, 'SIGKILL'); } catch { /* The owned group has normally exited. */ }
    }
  }, 60000);

  it('retains CLI files after an uncertain submission even when no process is visible yet', async () => {
    const { launchOwnedCodexSession, codexOwnedAdapter } = await import('@/lib/codex/owned');
    const { prepareOwnedLaunchArgs } = await import('@/lib/runtimes/shared/owned-session/launch-args');
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true); await finished(launched.surfaceId);
    const prepared = await prepareOwnedLaunchArgs({ adapter: codexOwnedAdapter, session: session(launched.surfaceId), runId: 'fixture-uncertain-submit',
      prompt: 'Use o8 packet commands.', mode: 'resume', sandboxEnabled: false, humanLabel: 'Fixture worker', artifactRoot: owned });
    try {
      await prepared.workerO8!.cleanupUnstarted(false);
      expect(existsSync(prepared.workerO8!.binDir)).toBe(true);
    } finally { await prepared.workerO8!.cleanupUnstarted(true); }
    expect(existsSync(prepared.workerO8!.binDir)).toBe(false);
  }, 60000);

  it('binds the shared CLI budget to one lifecycle database through the real launch entry', async () => {
    const { launchOwnedCodexSession } = await import('@/lib/codex/owned');
    const launched = await launchOwnedCodexSession({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high' });
    expect(launched.ok).toBe(true); await finished(launched.surfaceId);
    const alternate = join(root, 'alternate'); mkdirSync(alternate);
    const script = `const loaded = await import('./src/lib/codex/owned.ts'); const { launchOwnedCodexSession } = loaded.default ?? loaded;
try { console.log(JSON.stringify(await launchOwnedCodexSession({ cwd:${JSON.stringify(worktree)}, prompt:'Use o8 packet info.', packetId:${JSON.stringify(packetId)}, laneId:${JSON.stringify(laneId)}, model:'gpt-5.6-sol', effort:'high' }))); }
catch (error) { console.log(JSON.stringify({ok:false,note:error.message})); }`;
    const output = execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000, env: { ...process.env,
        CORTEX_IDE_DB_PATH: join(alternate, 'state.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(alternate, 'owned'),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.split('\n').find(line => line.startsWith('{"ok":'))!);
    expect(result.ok).toBe(false); expect(result.note).toContain('lifecycle');
  }, 60000);

  it.each(['arguments', 'environment', 'carrier'])('removes an unstarted CLI slot after failed %s preparation', async stage => {
    const { codexOwnedAdapter } = await import('@/lib/codex/owned');
    const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
    const cliRoot = join(data, 'worker-cli'); mkdirSync(cliRoot, { recursive: true });
    const before = readdirSync(cliRoot).sort();
    const adapter = { ...codexOwnedAdapter, rootEnvVar: 'O8_UNUSED_FIXTURE_ROOT', rootDefault: join(writableTmp, `failed-${stage}`),
      surfaceIdPrefix: `failed-${stage}:`, sessionIdPrefix: 'failed-',
      ...(stage === 'arguments' ? { launchArgs: () => { throw new Error('fixture argument failure'); } } : {}),
      ...(stage === 'environment' ? { extraSpawnEnv: async () => { throw new Error('fixture environment failure'); } } : {}),
    };
    const store = createOwnedSessionStore(adapter);
    const processProof = await import('@/lib/runtimes/shared/owned-session/run-process-proof');
    const unknownMarker = vi.spyOn(processProof, 'probeOwnedRunMarker').mockResolvedValue('unknown');
    try {
      await expect(store.launch({ cwd: worktree, prompt: 'Use o8 packet commands.', packetId, laneId, model: 'gpt-5.6-sol', effort: 'high',
        ...(stage === 'carrier' ? { runtimeConfig: { executionCarrier: 'unsupported-fixture-carrier' } } : {}) })).rejects.toThrow();
      expect(readdirSync(cliRoot).sort()).toEqual(before);
      expect(unknownMarker).not.toHaveBeenCalled();
    } finally { unknownMarker.mockRestore(); }
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
