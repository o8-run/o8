import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LaunchOptions } from '@/lib/runtimes/types';

// Exercise the clone implementation on Linux; only the filesystem capability probe is replaced.
vi.mock('@/lib/worktree/apfs', async original => ({
  ...await original<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: async () => ({ macos: true, apfs: true, sameVolume: true, canCowClone: true }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/runtime/capacity-service', () => ({ getRuntimeCapacityControlSnapshot: async () => ({ capacities: [] }) }));
vi.mock('@/lib/codebase-memory/indexer', () => ({ ensureCodebaseMemoryBootIndex: vi.fn() }));
vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
vi.mock('@/lib/runtimes', async (original) => ({
  ...await original<typeof import('@/lib/runtimes')>(),
  getRuntime: () => ({ id: 'claude-code', capabilities: { launch: true }, async launch(options: LaunchOptions) {
    launches.push(options);
    return { ok: true, note: 'fixture reviewer launched', sessionKey: `claude-code-owned:${options.packetId}`, sideEffect: 'none' };
  } }),
}));

const githubFixture = vi.hoisted(() => ({ sha: '', repo: 'fixture/repair' }));
vi.mock('@/lib/github-broker/auth', () => ({
  hasGitHubBrokerAccess: () => false,
  getInstallationForRepo: vi.fn(),
  getInstallationToken: vi.fn(),
  verifyGitHubWebhookSignature: vi.fn(),
  githubInstallationFetch: vi.fn(async (_repo: string, path: string) => ({ scope: 'fixture-scope', response:
    path.endsWith('/logs') ? new Response('fixture failing assertion: expected green') : Response.json(
      path.includes('/pulls/') ? { state: 'open', head: { sha: githubFixture.sha, ref: 'fork-only-branch', repo: { full_name: 'fixture/fork' } }, base: { ref: 'main' } }
        : path.includes('/check-runs') ? { check_runs: [{ id: 1, name: 'CI tests', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/repair/actions/runs/10/job/20' }] }
        : { head_sha: githubFixture.sha, workflow_name: 'Fixture CI' }) })),
}));

const launches: LaunchOptions[] = [];
const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout?.trim();
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-pr-')));
const data = join(root, 'data');
mkdirSync(data);
// Disposable checkouts must not depend on the operator's global Git identity.
const gitConfig = join(root, 'empty.gitconfig');
writeFileSync(gitConfig, '');
vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.O8_WORKTREE_ROOT = join(root, 'workspaces');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
// Fixture Git processes must never inherit the operator's provider credentials.
const { providerCredentialName } = await import('@/lib/providers/spawn-environment');
for (const name of Object.keys(process.env)) if (providerCredentialName(name)) vi.stubEnv(name, undefined);
const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
const { POST } = await import('@/app/api/orchestrator/delegate/route');
const repairPreparation = await import('@/app/api/panel/prs/[number]/repair/route');
const laneCommands = await import('@/lib/lane/commands');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { getLane, createLane, updateLane, archiveLane } = await import('@/lib/lane/registry');
const { readPinnedLaneCreationBaseCommit } = await import('@/lib/lane/creation-base');
const { addRepo } = await import('@/lib/repos/registry');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { closeDb } = await import('@/lib/db');
const run = promisify(execFile);
const sockets: string[] = [];

afterAll(() => {
  for (const socket of sockets) {
    try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
  closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
async function fixture(label: string, github = false) {
  const repo = join(root, label);
  mkdirSync(repo);
  git(repo, 'init', '-qb', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const origin = `${repo}.git`;
  git(root, 'clone', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'fetch', 'origin', 'main');
  writeFileSync(join(repo, 'pr-only.test.cjs'), "require('node:test')('PR-only check', () => require('node:assert/strict').equal(2 + 2, 4));\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'PR-only test');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', 'origin', 'HEAD:refs/pull/7/head');
  git(repo, 'reset', '--hard', base);
  // The PR object must be fetched, not accidentally available in the checkout.
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  git(repo, 'gc', '--prune=now');
  expect(() => git(repo, 'cat-file', '-e', head)).toThrow();
  if (github) {
    const remote = `https://github.com/${githubFixture.repo}.git`;
    git(repo, 'remote', 'set-url', 'origin', remote);
    githubFixture.sha = head;
  }
  await addRepo(repo);
  if (github) git(repo, 'config', `url.${origin}.insteadOf`, `https://github.com/${githubFixture.repo}.git`);
  await updateOperatorDefaults({ workerRuntimes: ['claude-code'] });
  return { repo, origin, base, head };
}
function request(repoPath: string, extra: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` }, body: JSON.stringify({
    clientMutationId: `review-pr-${crypto.randomUUID()}`, repoPath, runtime: 'claude-code',
    taskName: 'Review fixture PR', prompt: 'Review PR 7 and run its test.', readOnly: true,
    reviewPullRequest: 7, ...extra,
  }) });
}

describe('reviewer PR checkout through delegate dispatch', () => {
  it('runs selected failing job evidence through preparation, normal dispatch, real Git and persisted state', async () => {
    process.env.O8_APFS_COW_WORKSPACES = '0';
    const f = await fixture('repair-selected-entry', true);
    const response = await repairPreparation.POST(new NextRequest('http://localhost/api/panel/prs/7/repair?repo=fixture%2Frepair', {
      method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ expectedHeadSha: f.head, checks: ['1'], clientMutationId: 'selected-repair' }),
    }), { params: Promise.resolve({ number: '7' }) });
    expect(response.status).toBe(200);
    const prepared = await response.json();
    expect(prepared.delegation.prompt).toContain('fixture failing assertion');
    expect(prepared.delegation.prompt).toContain('Source repository: fixture/fork');
    expect(prepared.delegation.baseBranch).toBe('main');
    const launchedResponse = await POST(request(f.repo, { reviewPullRequest: undefined, ...prepared.delegation }));
    const result = await launchedResponse.json();
    expect(launchedResponse.status, JSON.stringify(result)).toBe(200);
    expect(git(launches.at(-1)!.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readOrchestratorControlPlaneState().packets.find(p => p.id === result.packetId)?.repairSource)
      .toEqual({ pullRequest: 7, headSha: f.head });
    // The ordinary completion contract compares only the repair against its immutable source.
    expect(launches.at(-1)!.prompt).toContain(`git diff ${f.head}...HEAD`);
    const replay = await POST(request(f.repo, { reviewPullRequest: undefined, ...prepared.delegation }));
    expect((await replay.json()).laneId).toBe(result.laneId);
    expect(getLane(result.laneId)?.prNumber).toBeNull();
  }, 90_000);

  it('refuses repair dispatch without operator authority before creating any state', async () => {
    const count = launches.length;
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST', body: JSON.stringify({
      clientMutationId: 'anonymous-repair', repoPath: root, prompt: 'fix', repairPullRequest: 7, expectedRepairHeadSha: 'a'.repeat(40),
    }) }));
    expect(response.status).toBe(403); expect(launches).toHaveLength(count);
  });

  it('defers repair to a durably associated owning lane, including an idle worker', async () => {
    const f = await fixture('repair-owner');
    const owner = createLane({ repoPath: f.repo, branch: 'existing-pr', baseBranch: 'main', runtime: 'claude-code', label: 'Existing PR worker' });
    updateLane(owner.id, { prNumber: 7 });
    const count = launches.length;
    const response = await POST(request(f.repo, { reviewPullRequest: undefined, readOnly: false,
      repairPullRequest: 7, expectedRepairHeadSha: f.head }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'pr_has_owner', ownerLaneId: owner.id });
    expect(launches).toHaveLength(count);
  }, 90_000);

  it('allows a fresh repair after lane admission failed without creating a worker', async () => {
    const f = await fixture('repair-admission-retry');
    const open = vi.spyOn(laneCommands, 'dispatch').mockResolvedValueOnce({ ok: false, laneId: '', note: 'fixture lane admission refused' });
    const body = { reviewPullRequest: undefined, readOnly: false, repairPullRequest: 7, expectedRepairHeadSha: f.head };
    const first = await POST(request(f.repo, body));
    open.mockRestore();
    expect(first.status).toBe(422);
    const result = await first.json();
    expect(readOrchestratorControlPlaneState().packets.find(p => p.id === result.packetId)?.archivedAt).toBeTruthy();
    const retry = await POST(request(f.repo, body));
    expect(retry.status, JSON.stringify(await retry.json())).toBe(200);
  }, 90_000);

  it('allows a new repair after the previous repair lane was explicitly archived', async () => {
    const f = await fixture('repair-retired-owner');
    const body = { reviewPullRequest: undefined, readOnly: false, repairPullRequest: 7, expectedRepairHeadSha: f.head };
    const first = await POST(request(f.repo, body));
    const receipt = await first.json(); expect(first.status).toBe(200);
    archiveLane(receipt.laneId);
    const retry = await POST(request(f.repo, body));
    expect(retry.status, JSON.stringify(await retry.json())).toBe(200);
  }, 90_000);

  it('admits only one repair owner when two normal dispatches race', async () => {
    const f = await fixture('repair-race');
    const body = { reviewPullRequest: undefined, readOnly: false, repairPullRequest: 7, expectedRepairHeadSha: f.head };
    const results = await Promise.all([POST(request(f.repo, body)), POST(request(f.repo, body))]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  }, 90_000);

  it('starts an editable repair at the selected PR head and durably records that source', async () => {
    process.env.O8_APFS_COW_WORKSPACES = '0';
    const f = await fixture('repair-head');
    // Match an isolated CI checkout without a configured commit author.
    git(f.repo, 'config', '--unset', 'user.name');
    git(f.repo, 'config', '--unset', 'user.email');
    const response = await POST(request(f.repo, { reviewPullRequest: undefined, readOnly: false,
      repairPullRequest: 7, expectedRepairHeadSha: f.head }));
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    const launched = launches.at(-1)!;
    expect(launched.workMode).toBe('edit');
    expect(git(launched.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readPinnedLaneCreationBaseCommit(result.laneId)).toBe(f.head);
    expect(readOrchestratorControlPlaneState().packets.find(p => p.id === result.packetId))
      .toMatchObject({ repairSource: { pullRequest: 7, headSha: f.head } });
    expect(result.repairSource).toEqual({ pullRequest: 7, headSha: f.head });
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.base);
    const { assertReviewerPrCheckout } = await import('@/lib/orchestrator/reviewer-pr-source');
    git(launched.cwd!, 'config', 'user.useConfigOnly', 'true');
    writeFileSync(join(launched.cwd!, 'repair.txt'), 'repair commit\n');
    git(launched.cwd!, 'add', 'repair.txt');
    git(launched.cwd!, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'repair');
    await expect(assertReviewerPrCheckout(result.packetId, launched.cwd!)).resolves.toBeUndefined();
    git(launched.cwd!, 'checkout', '--detach', f.base);
    await expect(assertReviewerPrCheckout(result.packetId, launched.cwd!)).rejects.toThrow('pinned PR head');
  }, 90_000);

  it('refuses stale repair evidence before creating a packet, lane or worker', async () => {
    const f = await fixture('repair-stale');
    git(f.origin, 'update-ref', 'refs/pull/7/head', f.base);
    const count = launches.length;
    const packets = readOrchestratorControlPlaneState().packets.length;
    const response = await POST(request(f.repo, { reviewPullRequest: undefined, readOnly: false,
      repairPullRequest: 7, expectedRepairHeadSha: f.head }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: 'stale_pr_head' });
    expect(launches).toHaveLength(count);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(packets);
  }, 90_000);

  it('binds repair source pins to the normal delegation mutation identity', async () => {
    const f = await fixture('repair-replay');
    const body = { clientMutationId: 'repair-source-replay', reviewPullRequest: undefined, readOnly: false,
      repairPullRequest: 7, expectedRepairHeadSha: f.head };
    expect((await POST(request(f.repo, body))).status).toBe(200);
    const count = launches.length;
    const response = await POST(request(f.repo, { ...body, expectedRepairHeadSha: f.base }));
    expect(response.status).toBe(409); expect(launches).toHaveLength(count);
  }, 90_000);

  it.skipIf(!tmux).each(['git-worktree', 'clone'])('pins the PR head in a %s, runs its test with CLI receipts, and replays the same head', async isolation => {
    process.env.O8_APFS_COW_WORKSPACES = isolation === 'clone' ? '1' : '0';
    const f = await fixture('exact-head-' + isolation);
    const artifacts = join(root, 'artifacts-' + isolation);
    mkdirSync(artifacts);
    // Keep the real native SQLite package external to the disposable ESM bundle.
    symlinkSync(join(process.cwd(), 'node_modules'), join(artifacts, 'node_modules'), 'dir');
    const body = { clientMutationId: 'review-pr-exact-head-' + isolation };
    const response = await POST(request(f.repo, body));
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    const launched = launches.at(-1)!;
    expect(launched.workMode).toBe('read-only');
    expect(git(launched.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readPinnedLaneCreationBaseCommit(result.laneId)).toBe(f.head);
    expect(git(launched.cwd!, 'diff', 'main...HEAD', '--name-only')).toContain('pr-only.test.cjs');
    expect(readOrchestratorControlPlaneState().packets.find(p => p.id === result.packetId))
      .toMatchObject({ reviewSource: { pullRequest: 7, headSha: f.head } });
    expect(getLane(result.laneId)?.worktreePath).toBe(launched.cwd);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(existsSync(join(f.repo, 'pr-only.test.cjs'))).toBe(false);

    const bundle = join(artifacts, 'o8.mjs');
    await build({ entryPoints: ['cli/src/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['better-sqlite3'],
      define: { __O8_CLI_VERSION__: JSON.stringify('test') }, banner: { js: `import { createRequire as __fixtureRequire } from 'node:module';
import { fileURLToPath as __fixtureFileURLToPath } from 'node:url';
import { dirname as __fixtureDirname } from 'node:path';
const require = __fixtureRequire(${JSON.stringify(join(process.cwd(), 'package.json'))}); globalThis.require = require;
const __filename = __fixtureFileURLToPath(import.meta.url); const __dirname = __fixtureDirname(__filename);` } });
    const bin = join(artifacts, 'bin');
    mkdirSync(bin);
    // Darwin's Unix-domain socket limit is shorter than the isolated test root.
    const socket = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `o8-review-${crypto.randomUUID()}.sock`);
    sockets.push(socket);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`, { mode: 0o700 });
    chmodSync(join(bin, 'tmux'), 0o700);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', 'sleep 90']);
    const registrations: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (payload.action === 'register') registrations.push(payload);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.startsWith('/api/lanes')
        ? { lanes: [{ id: result.laneId, packetId: result.packetId, worktreePath: launched.cwd }] } : { ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture port');
      const temp = join(artifacts, 'tmp');
      mkdirSync(temp);
      const marker = '1792655458237-1234abcd';
      const checked = await run(process.execPath, [bundle, 'run', '--', process.execPath, '--test', 'pr-only.test.cjs'], {
        cwd: launched.cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp,
          O8_OWNED_RUN_MARKER: marker, O8_WORKER_PACKET_ID: result.packetId, O8_WORKER_TOKEN: 'fixture',
          O8_API_PORT: String(address.port), O8_API_TOKEN: '', NODE_OPTIONS: '' }, timeout: 20_000,
      });
      expect(checked.stdout).toContain('PR-only check');
      const directory = join(temp, 'o8-worker-runs', marker, 'logs', 'run');
      const metadata = readdirSync(directory).find(name => name.endsWith('.json'))!;
      const receipt = JSON.parse(readFileSync(join(directory, metadata), 'utf8'));
      expect(readFileSync(join(directory, `${receipt.id}.exit`), 'utf8')).toBe('0');
      expect(readFileSync(join(directory, `${receipt.id}.log`), 'utf8')).toContain('PR-only check');
      expect(registrations).toEqual([expect.objectContaining({ packetId: result.packetId, laneId: result.laneId })]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const count = launches.length;
    git(f.origin, 'update-ref', 'refs/pull/7/head', f.base);
    expect(await (await POST(request(f.repo, body))).json()).toMatchObject({ replayed: true, packetId: result.packetId });
    expect(launches).toHaveLength(count);
    expect(git(launched.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect((await POST(request(f.repo, { ...body, reviewPullRequest: 8 }))).status).toBe(409);
    // A relaunch or fallback must refuse a stale/replaced checkout before the runtime sees it.
    await expect(launchRuntimeSurface({ runtime: 'claude-code', packetId: result.packetId,
      repoPath: f.repo, prompt: 'Review the pinned PR', isolate: false, skipSetup: true }))
      .rejects.toThrow('Reviewer checkout does not match its pinned PR head');
    expect(launches).toHaveLength(count);
  }, 90_000);

  it('forwards the explicit PR target through the agent tool to persisted dispatch', async () => {
    process.env.O8_APFS_COW_WORKSPACES = '0';
    const f = await fixture('mcp-entry');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/orchestrator/delegate')) return POST(new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined }));
      return Response.json({ ok: true });
    });
    try {
      const handlers = createCortexDelegationHandlers({ apiFetch: async () => ({}), apiBase: 'http://localhost',
        repoPath: f.repo, parentThreadId: '', fastCapability: '', wsToken: 'fixture' });
      const response = await handlers.handleLaunchAgent({ prompt: 'Review PR 7', runtime: 'claude-code',
        readOnly: true, reviewPullRequest: 7 });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const result = JSON.parse(response.content[0].text);
      expect(result.ok).toBe(true);
      expect(result.reviewSource).toEqual({ pullRequest: 7, headSha: f.head });
      expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(f.head);
      const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === getLane(result.laneId)?.packetId);
      expect(packet).toMatchObject({ reviewSource: { pullRequest: 7, headSha: f.head } });
    } finally { fetchSpy.mockRestore(); }
  });

  it.each([0, -1, '7', 1.5])('refuses malformed PR number %s before creating a packet', async number => {
    const count = readOrchestratorControlPlaneState().packets.length;
    const response = await POST(request(root, { reviewPullRequest: number }));
    expect(response.status).toBe(400);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(count);
  });

  it('refuses a PR target in editable or shared mode', async () => {
    for (const extra of [{ readOnly: false }, { checkoutMode: 'shared' }]) {
      expect((await POST(request(root, extra))).status).toBe(400);
    }
  });

  it('refuses a missing PR ref without launching on the base', async () => {
    const f = await fixture('missing-ref');
    const count = launches.length;
    const packets = readOrchestratorControlPlaneState().packets.length;
    const response = await POST(request(f.repo, { reviewPullRequest: 404 }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, code: 'review_source_unavailable' });
    expect(launches).toHaveLength(count);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(packets);
  });
});
