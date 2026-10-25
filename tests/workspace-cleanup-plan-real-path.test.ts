import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ failAfterRename: false, failAfterReturn: false, failAfterOwnership: false, ownershipDepth: 0 }));
vi.mock('@/lib/workspace/retirement-process-authority', async original => {
  const actual = await original<typeof import('@/lib/workspace/retirement-process-authority')>();
  return { ...actual, withManagedRetirementOwnership: async (...args: Parameters<typeof actual.withManagedRetirementOwnership>) => {
    const depth = ++seams.ownershipDepth;
    try {
      const result = await actual.withManagedRetirementOwnership(...args);
      if (depth === 1 && seams.failAfterOwnership) { seams.failAfterOwnership = false; throw new Error('fixture lost lifecycle release reply'); }
      return result;
    } finally { seams.ownershipDepth -= 1; }
  } };
});
vi.mock('@/lib/workspace/generated-output-retirement', async original => {
  const actual = await original<typeof import('@/lib/workspace/generated-output-retirement')>();
  return { ...actual, retireGeneratedOutput: async (id: string) => { const result = await actual.retireGeneratedOutput(id, {
    afterRename: async () => { if (seams.failAfterRename) { seams.failAfterRename = false; throw new Error('fixture interrupted after exact rename'); } },
  }); if (seams.failAfterReturn) { seams.failAfterReturn = false; throw new Error('fixture lost native completion reply'); } return result; } };
});

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-cleanup-plan-')));
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
process.env.O8_WORKTREE_ROOT = path.join(root, 'workspaces');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'sessions');
mkdirSync(process.env.O8_WORKTREE_ROOT);
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn() }));
const { closeDb, getSqlite } = await import('@/lib/db');
const { addRepo } = await import('@/lib/repos/registry');
const { createLane } = await import('@/lib/lane/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { readMaintenanceState, writeMaintenanceState } = await import('@/lib/worktree/maintenance-discovery');
const route = await import('@/app/api/orchestrator/workspace/maintenance/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { adoptGeneratedOutput } = await import('@/lib/workspace/generated-output-retirement');
const { recoverGeneratedOutput } = await import('@/lib/workspace/generated-output-recovery');
const token = getOrCreateWsToken();
let sequence = 0;
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
async function fixture() {
  const repoPath = path.join(root, `repo-${++sequence}`); mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repoPath, 'README.md'), 'preserved source\n');
  writeFileSync(path.join(repoPath, '.gitignore'), '.next\nnode_modules\n.o8-generated-output-store\n*.log\n');
  git(repoPath, 'add', '.'); git(repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const repo = await addRepo(repoPath);
  const manager = getWorktreeManager(repoPath);
  async function workspace(terminal = true) {
    const packetId = `cleanup-${++sequence}`; const sessionKey = `codex-owned:${packetId}`;
    const lane = createLane({ repoPath, packetId, runtime: 'codex', sessionKey, branch: `inline/${packetId}`, baseBranch: 'main' });
    const workspace = await manager.create({ agentType: 'codex', taskName: packetId, packetId, laneId: lane.id,
      branchName: lane.branch, baseBranch: 'main', managed: true, isolationPreference: 'git-worktree', skipSetup: true });
    await withWorktreeMetaTransaction(repoPath, async tx => {
      const entry = (await tx.readAll())[workspace.id]!; await tx.save(entry.id, { ...entry, sessionKey });
    });
    const sessionDir = path.join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, packetId); mkdirSync(sessionDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ surfaceId: sessionKey, packetId, sessionDir,
      cwd: workspace.path, repoPath: workspace.path, title: packetId, createdAt: now, updatedAt: now,
      latestPrompt: '', latestSummary: '', recentRuns: [], runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
      workspaceBinding: { logicalWorkspaceId: `packet:${packetId}`, repositoryUuid: repo.id, packetId,
        cwd: workspace.path, version: 1, verifiedAt: now } }));
    getSqlite().prepare('UPDATE lanes SET status = ?, worktree_path = ? WHERE id = ?')
      .run(terminal ? 'archived' : 'running', workspace.path, lane.id);
    return { ...workspace, laneId: lane.id };
  }
  return { repoPath, repoId: repo.id, manager, workspace };
}
async function post(body: unknown, bearer = token) {
  const request = new NextRequest('http://localhost/api/orchestrator/workspace/maintenance', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const handler = (route as Record<string, unknown>).POST;
  return typeof handler === 'function' ? handler(request) as Promise<Response> : new Response('Method not allowed', { status: 405 });
}
async function preview(repoPath: string) {
  const response = await post({ action: 'preview', repoPath });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).result.plan;
}
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

// Real Git, volume identity and process probes have multiple bounded native steps.
// The generic 30s deadline (and 60s on a three-workspace case) can expire before
// they settle on a shared Mac, leaving work running into the next test's state.
describe('reviewed cleanup through native lifecycle operations', { timeout: 120_000, concurrent: false, shuffle: false }, () => {

it('previews exact terminal ownership without removing source, and holds active work', async () => {
  const f = await fixture(); const done = await f.workspace(); const active = await f.workspace(false);
  const plan = await preview(f.repoPath);
  expect(plan.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ worktreeId: done.id, eligible: true, kind: 'workspace', identity: expect.objectContaining({ canonicalPath: done.path }) }),
    expect.objectContaining({ worktreeId: active.id, eligible: false, reason: expect.stringContaining('terminal') }),
  ]));
  expect(readFileSync(path.join(done.path, 'README.md'), 'utf8')).toBe('preserved source\n');
  expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it('executes only the approved selection and retains recovery', async () => {
  const f = await fixture(); const done = await f.workspace(); const unselected = await f.workspace();
  writeFileSync(path.join(done.path, 'reviewed-receipt.log'), 'unchanged reviewed ignored evidence');
  const plan = await preview(f.repoPath);
  const selected = plan.entries.find((entry: { worktreeId: string; kind: string }) => entry.worktreeId === done.id && entry.kind === 'workspace');
  const late = await f.workspace();
  const body = { action: 'execute', planId: plan.id, selection: [selected.id], fingerprint: plan.fingerprint };
  const response = await post(body); expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()).result.plan;
  expect(result.outcomes).toEqual([expect.objectContaining({ entryId: selected.id, state: 'removed', recovery: expect.anything() })]);
  expect(existsSync(done.path)).toBe(false); expect(existsSync(unselected.path)).toBe(true); expect(existsSync(late.path)).toBe(true);
  expect(git(f.repoPath, 'rev-parse', done.branch)).toMatch(/^[a-f0-9]{40}$/);
  expect((await (await post(body)).json()).result.plan).toEqual(result);
});

it('refuses changed source after preview and never silently adds new work', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  writeFileSync(path.join(done.path, 'README.md'), 'new unreviewed source\n');
  const entry = plan.entries.find((entry: { worktreeId: string; kind: string }) => entry.worktreeId === done.id && entry.kind === 'workspace');
  const response = await post({ action: 'execute', planId: plan.id, selection: [entry.id], fingerprint: plan.fingerprint });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).result.plan.outcomes).toEqual([expect.objectContaining({ state: 'held' })]);
  expect(readFileSync(path.join(done.path, 'README.md'), 'utf8')).toBe('new unreviewed source\n');
});

it.each(['addition', 'rename', 'symlink swap', 'size', 'mtime', 'deletion'])('requires renewed review after an ignored file %s', async change => {
  const f = await fixture(); const done = await f.workspace();
  const directory = ['rename', 'size', 'mtime'].includes(change) ? path.join(done.path, 'node_modules', 'cache') : done.path;
  mkdirSync(directory, { recursive: true });
  const ignored = path.join(directory, 'receipt.log');
  const target = path.join(root, `target-${++sequence}`);
  writeFileSync(target, 'retained external evidence');
  if (change === 'symlink swap') symlinkSync(target, ignored);
  else writeFileSync(ignored, 'reviewed ignored evidence');
  const plan = await preview(f.repoPath);
  const entry = plan.entries.find((entry: { worktreeId: string }) => entry.worktreeId === done.id);
  expect(entry.eligible, entry.reason).toBe(true);
  if (change === 'addition') writeFileSync(path.join(done.path, 'new-unique-receipt.log'), 'new evidence');
  else if (change === 'rename') renameSync(ignored, path.join(directory, 'renamed\nreceipt.log'));
  else if (change === 'symlink swap') {
    const replacement = `${target}-replacement`; writeFileSync(replacement, 'other external evidence');
    unlinkSync(ignored); symlinkSync(replacement, ignored);
  } else if (change === 'size') writeFileSync(ignored, 'longer unreviewed ignored evidence');
  else if (change === 'mtime') {
    const previous = statSync(ignored); utimesSync(ignored, previous.atime, new Date(previous.mtimeMs + 10_000));
  } else unlinkSync(ignored);
  const response = await post({ action: 'execute', planId: plan.id, selection: [entry.id], fingerprint: plan.fingerprint });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()).result.plan;
  expect(result.outcomes).toEqual([expect.objectContaining({ state: 'held', reason: expect.stringMatching(/changed/i) })]);
  expect(existsSync(done.path)).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('retained external evidence');
  const renewed = await preview(f.repoPath);
  expect(renewed.entries[0].eligible, renewed.entries[0].reason).toBe(true);
  expect(renewed.entries[0].fingerprint).not.toBe(entry.fingerprint);
});

it('refuses a wrong fingerprint, foreign selection, and worker authority before any cleanup', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  const entry = plan.entries.find((entry: { worktreeId: string; kind: string }) => entry.worktreeId === done.id && entry.kind === 'workspace');
  for (const body of [
    { fingerprint: '0'.repeat(64), selection: [entry.id] },
    { fingerprint: plan.fingerprint, selection: ['not-in-this-plan'] },
  ]) expect((await post({ action: 'execute', planId: plan.id, ...body })).status).toBe(409);
  expect((await post({ action: 'preview', repoPath: f.repoPath }, mintPacketWorkerToken('fixture-worker'))).status).toBe(403);
  expect(existsSync(done.path)).toBe(true);
});

it('previews and executes the same selected plan through authenticated HTTP and the built CLI', async () => {
  const f = await fixture(); const done = await f.workspace();
  const { panelGateMiddleware } = await import('@/middleware');
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const req = new NextRequest(`http://localhost${request.url}`, { method: request.method,
        headers: { host: 'localhost', authorization: request.headers.authorization ?? '', 'content-type': 'application/json' },
        ...(request.method === 'POST' ? { body } : {}) });
      const gate = panelGateMiddleware(req);
      const handler = request.method === 'POST' ? (route as Record<string, unknown>).POST : route.GET;
      const result = gate && !gate.headers.get('x-middleware-next') ? gate : typeof handler === 'function'
        ? await handler(req) : new Response('Method not allowed', { status: 405 });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text());
    } catch { response.writeHead(500); response.end('Fixture request failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const exec = promisify(execFile);
  const cli = (...args: string[]) => exec(process.execPath, ['cli/dist/o8.mjs', 'workspace-cleanup', ...args], {
    cwd: process.cwd(), env: { ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: token, O8_WORKER_TOKEN: '' }, timeout: 60_000,
  });
  try {
    await exec(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd(), timeout: 60_000 });
    const plan = JSON.parse((await cli('preview', '--repo', f.repoPath)).stdout).result.plan;
    const entry = plan.entries.find((entry: { worktreeId: string }) => entry.worktreeId === done.id);
    const result = JSON.parse((await cli('execute', '--plan', plan.id, '--approve', plan.fingerprint, '--entry', entry.id)).stdout).result.plan;
    expect(result.outcomes[0].state).toBe('removed'); expect(existsSync(done.path)).toBe(false);
    expect(JSON.parse((await cli('status', '--plan', plan.id)).stdout).result.plan).toEqual(result);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('holds generated output that appeared after the reviewed workspace preview', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  mkdirSync(path.join(done.path, '.next')); writeFileSync(path.join(done.path, '.next', 'unique.txt'), 'new output');
  const entry = plan.entries.find((entry: { worktreeId: string }) => entry.worktreeId === done.id);
  const response = await post({ action: 'execute', planId: plan.id, selection: [entry.id], fingerprint: plan.fingerprint });
  expect(response.status).toBe(200);
  expect((await response.json()).result.plan.outcomes[0].state).toBe('held');
  expect(readFileSync(path.join(done.path, '.next', 'unique.txt'), 'utf8')).toBe('new output');
});

it('refuses historical removal proof when a replacement public namespace exists', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  const entry = plan.entries.find((entry: { worktreeId: string }) => entry.worktreeId === done.id);
  const body = { action: 'execute', planId: plan.id, selection: [entry.id], fingerprint: plan.fingerprint };
  const removed = (await (await post(body)).json()).result.plan;
  expect(removed.outcomes[0].state).toBe('removed');
  // The exact persisted seam after native removal but before its response was recorded.
  const pending = { ...removed, status: 'running', outcomes: [{ entryId: entry.id, state: 'started', startedAt: removed.approvedAt }] };
  writeMaintenanceState(`cleanup-plan:${plan.id}`, pending);
  mkdirSync(done.path); writeFileSync(path.join(done.path, 'replacement.txt'), 'different generation');
  const response = await post(body);
  expect((await response.json()).result.plan.outcomes[0].state).toBe('held');
  expect(readFileSync(path.join(done.path, 'replacement.txt'), 'utf8')).toBe('different generation');
});

it('requires renewed review for ignored output inside a separately selected generated generation', async () => {
  const f = await fixture(); const done = await f.workspace();
  const next = path.join(done.path, '.next'); mkdirSync(next); writeFileSync(path.join(next, 'receipt.txt'), 'reviewed build');
  const evidence = [path.join(root, `source-${++sequence}.txt`), path.join(root, `stop-${++sequence}.txt`)];
  evidence.forEach(file => writeFileSync(file, 'fixture completion evidence'));
  const adopted = await adoptGeneratedOutput({ workspacePath: done.path,
    owner: { repositoryPath: f.repoPath, worktreeId: done.id }, intent: 'Retain the reviewed build', evidencePaths: evidence });
  await recoverGeneratedOutput(adopted.resourceId);
  const plan = await preview(f.repoPath);
  expect(plan.entries.every((entry: { eligible: boolean }) => entry.eligible), JSON.stringify(plan.entries)).toBe(true);
  writeFileSync(path.join(next, 'new-unique-receipt.log'), 'unreviewed build evidence');
  const response = await post({ action: 'execute', planId: plan.id, fingerprint: plan.fingerprint,
    selection: plan.entries.map((entry: { id: string }) => entry.id) });
  const result = (await response.json()).result.plan;
  expect(result.outcomes).toEqual([
    expect.objectContaining({ entryId: `generated-output:${adopted.resourceId}`, state: 'held', reason: expect.stringContaining('changed') }),
    expect.objectContaining({ entryId: `workspace:${done.id}`, state: 'held' }),
  ]);
  expect(readFileSync(path.join(next, 'new-unique-receipt.log'), 'utf8')).toBe('unreviewed build evidence');
});

it('retains a pending generated-output claim after an interrupted rename and resumes consumer before workspace', async () => {
  const f = await fixture(); const done = await f.workspace();
  const next = path.join(done.path, '.next'); mkdirSync(next); writeFileSync(path.join(next, 'receipt.txt'), 'unique build evidence');
  const evidence = [path.join(root, `source-${++sequence}.txt`), path.join(root, `stop-${++sequence}.txt`)];
  evidence.forEach(file => writeFileSync(file, 'fixture completion and source evidence', { mode: 0o600 }));
  const adopted = await adoptGeneratedOutput({ workspacePath: done.path,
    owner: { repositoryPath: f.repoPath, worktreeId: done.id }, intent: 'Retain the exact fixture output before approved cleanup', evidencePaths: evidence });
  const recovered = await recoverGeneratedOutput(adopted.resourceId);
  const plan = await preview(f.repoPath);
  expect(plan.entries.every((entry: { eligible: boolean }) => entry.eligible), JSON.stringify(plan.entries)).toBe(true);
  const body = { action: 'execute', planId: plan.id, selection: plan.entries.map((entry: { id: string }) => entry.id), fingerprint: plan.fingerprint };
  seams.failAfterRename = true;
  const first = (await (await post(body)).json()).result.plan;
  expect(first.status).toBe('running');
  expect(readMaintenanceState<{ status: string }>(`cleanup-plan:${plan.id}`)?.status).toBe('running');
  expect(first.outcomes).toEqual([expect.objectContaining({ state: 'started' })]);
  expect(existsSync(done.path)).toBe(true); expect(existsSync(next)).toBe(false);
  seams.failAfterReturn = true;
  const second = (await (await post(body)).json()).result.plan;
  expect(second.status, JSON.stringify(second.outcomes)).toBe('settled');
  expect(second.outcomes.map((entry: { state: string }) => entry.state)).toEqual(['removed', 'removed']);
  expect(second.outcomes.map((entry: { entryId: string }) => entry.entryId)).toEqual([
    `generated-output:${adopted.resourceId}`, `workspace:${done.id}`,
  ]);
  expect(existsSync(done.path)).toBe(false);
  expect(existsSync(adopted.bank!.root.canonicalPath)).toBe(true);
  expect(readFileSync(path.join(recovered.recovery!.path, 'receipt.txt'), 'utf8')).toBe('unique build evidence');
});

it('refuses a competing native executor and resumes only after its exact process exits', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  const entry = plan.entries.find((entry: { worktreeId: string }) => entry.worktreeId === done.id);
  const entered = path.join(root, `lease-${++sequence}.txt`);
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'tests/fixtures/workspace-cleanup-plan-lease-child.ts'), plan.id, entered], { cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = once(child, 'message', { signal: AbortSignal.timeout(60_000) });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const body = { action: 'execute', planId: plan.id, selection: [entry.id], fingerprint: plan.fingerprint };
  try {
    const message = await Promise.race([ready, closed.then(() => { throw new Error(`Competing fixture exited before acquiring its lease: ${stderr}`); })]);
    expect(message[0], stderr).toEqual({ ready: true });
    expect(readFileSync(entered, 'utf8')).toBe('exact plan lease acquired');
    expect((await post(body)).status).toBe(409); expect(existsSync(done.path)).toBe(true);
    expect(readMaintenanceState<{ status: string }>(`cleanup-plan:${plan.id}`)?.status).toBe('preview');
  } finally { child.kill('SIGKILL'); await closed; }
  const result = (await (await post(body)).json()).result.plan;
  expect(result.outcomes[0].state).toBe('removed'); expect(existsSync(done.path)).toBe(false);
});

it('holds a dependency donor consumed by unsupported linked output and retains unique evidence', async () => {
  const f = await fixture(); const done = await f.workspace();
  const donor = path.join(done.path, 'node_modules'); const next = path.join(done.path, '.next');
  mkdirSync(donor); mkdirSync(next);
  writeFileSync(path.join(donor, 'dependency.txt'), 'donor content');
  writeFileSync(path.join(next, 'receipt.txt'), 'unique evidence');
  symlinkSync(donor, path.join(next, 'dependency'), 'dir');
  const evidence = [path.join(root, `evidence-${++sequence}.txt`), path.join(root, `stopped-${++sequence}.txt`)];
  evidence.forEach(file => writeFileSync(file, 'retained completion evidence'));
  await expect(adoptGeneratedOutput({ workspacePath: done.path,
    owner: { repositoryPath: f.repoPath, worktreeId: done.id }, intent: 'Inspect a linked consumer without granting retirement authority', evidencePaths: evidence }))
    .rejects.toThrow(/links|bank/);
  const plan = await preview(f.repoPath);
  expect(plan.entries.every((entry: { eligible: boolean }) => !entry.eligible)).toBe(true);
  const workspace = plan.entries.find((entry: { kind: string }) => entry.kind === 'workspace');
  expect(workspace.dependencies).toHaveLength(1);
  expect((await post({ action: 'execute', planId: plan.id, fingerprint: plan.fingerprint, selection: [workspace.id] })).status).toBe(409);
  expect(readFileSync(path.join(next, 'receipt.txt'), 'utf8')).toBe('unique evidence');
  expect(readFileSync(path.join(donor, 'dependency.txt'), 'utf8')).toBe('donor content');
});

it('records a fresh lifecycle admission refusal per entry and continues unrelated approved work', async () => {
  const f = await fixture(); const ambiguous = await f.workspace(); const other = await f.workspace();
  const plan = await preview(f.repoPath);
  const competing = createLane({ repoPath: f.repoPath, packetId: `competing-${++sequence}`, runtime: 'codex',
    branch: 'inline/competing-owner', baseBranch: 'main' });
  getSqlite().prepare('UPDATE lanes SET status = ?, worktree_path = ? WHERE id = ?').run('archived', ambiguous.path, competing.id);
  seams.failAfterOwnership = true;
  const response = await post({ action: 'execute', planId: plan.id, fingerprint: plan.fingerprint,
    selection: plan.entries.map((entry: { id: string }) => entry.id) });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()).result.plan;
  expect(result.outcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({ entryId: `workspace:${ambiguous.id}`, state: 'held', reason: expect.stringContaining('ambiguous') }),
    expect.objectContaining({ entryId: `workspace:${other.id}`, state: 'removed' }),
  ]));
  expect(existsSync(ambiguous.path)).toBe(true); expect(existsSync(other.path)).toBe(false);
});

it('reopens its own durable plan and returns the identical completed receipt', async () => {
  const f = await fixture(); const done = await f.workspace(); const plan = await preview(f.repoPath);
  const body = { action: 'execute', planId: plan.id, fingerprint: plan.fingerprint,
    selection: [`workspace:${done.id}`] };
  const result = (await (await post(body)).json()).result.plan;
  expect(result.outcomes[0].state).toBe('removed');
  // Close only after the last native fixture: its admission store owns its connection.
  closeDb();
  expect((await (await post(body)).json()).result.plan).toEqual(result);
});
});
