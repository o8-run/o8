import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Provider inference and the OS sandbox are substituted. The route, account
// lease, Git worktree, runtime launch, owned journal and child process are real.
const ready = vi.hoisted(() => vi.fn(async () => {}));
const sync = vi.hoisted(() => vi.fn());
const ruleHome = vi.hoisted(() => ({ path: '' }));
const fixtureChildren = vi.hoisted(() => ({
  lifetime: null as ReturnType<typeof import('./fixtures/fixture-child-lifetime.fixture').createFixtureChildLifetime> | null,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { createFixtureChildLifetime } = await import('./fixtures/fixture-child-lifetime.fixture');
  const lifetime = createFixtureChildLifetime();
  fixtureChildren.lifetime = lifetime;
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => lifetime.track(actual.spawn(...args)) };
});
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => ruleHome.path || actual.homedir() };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  sync.mockImplementation(actual.fsyncSync);
  return { ...actual, fsyncSync: sync };
});
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: ready }));
// #4899 admits a Codex effort only with the launching account's model/list evidence; the fixture
// advertises its model's effort instead of running the real codex app-server.
vi.mock('@/lib/codex/service-tier-catalogue', async (original) => ({
  ...await original<typeof import('@/lib/codex/service-tier-catalogue')>(),
  getCodexSpeedCatalogue: async () => ({ models: { 'gpt-6.1-sol': [] }, reasoningEfforts: { 'gpt-6.1-sol': ['high'] } }),
}));
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async (input: { binary: string; args: string[]; finalDenyPaths?: string[]; readOwnerInstructions?: boolean }) => {
    if (input.finalDenyPaths?.length) expect(input.readOwnerInstructions).toBe(false);
    return input;
  },
}));

import { POST } from '@/app/api/plugins/mcp/route';
import { GET as inspectDrafts } from '@/app/api/plugins/task-drafts/route';
import { POST as control } from '@/app/api/plugins/task-drafts/control/route';
import { createOwnedSessionStore, type OwnedRuntimeAdapter, type OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import { getRuntime, registerRuntime } from '@/lib/runtimes';
import { readTaskExecution, reserveTaskExecution, withTaskExecutionLock } from '@/lib/mcp/task-execution-store';
import { allowAccountRefresh, holdAccountRefresh } from '@/lib/auth/account-state';
import { mintPluginToken, PLUGIN_PREPARE_TASK_SCOPE } from '@/lib/auth/plugin-token';
import { publishReadyAccountState, withAccountStateLease } from '@/lib/auth/account-state';
import { getDataDir } from '@/lib/data-dir-migration';
import { bumpSignInEpoch, clearActiveIdentity, readSignInEpoch, writeActiveIdentity } from '@/lib/github-broker/managed';
import { listTaskDrafts, taskDraftRoot } from '@/lib/mcp/task-draft-store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState, readOrchestratorMissionState } from '@/lib/orchestrator/store';
import { addRepoToProject, createProject } from '@/lib/projects/store';
import { upsertProjectLedgerRecord } from '@/lib/repos/projects';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { panelGateMiddleware } from '@/middleware';

const keys = generateKeyPairSync('ed25519');
const oldKey = process.env.O8_LICENSE_PUBKEY;
const dirs: string[] = [];
let repo: string;
let projectId: string;
let repoId: string;
const oldOwnedRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
const oldClaudeRoot = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
const oldFixtureBinary = process.env.O8_TASK_DISPATCH_FIXTURE_BIN;
let fixtureRoot: string;
let output: string;
let persistent = true;
let journalDelayMs = 0;
let fixtureRuntime: 'codex' | 'claude-code' = 'codex';
let store: ReturnType<typeof createOwnedSessionStore>;
const accountId = 'user_fixture_task_draft';
// Reconciliation can await a three-second process scan before returning its snapshot.
const completionPoll = { timeout: 10_000 };

async function account(subject = accountId, expiry = 3600) {
  await withAccountStateLease(() => {
  writeActiveIdentity(subject);
  bumpSignInEpoch();
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, plan: 'free', exp: Math.floor(Date.now() / 1000) + expiry })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const licenseKey = `${unsigned}.${sign(null, Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
  writeFileSync(join(getDataDir(), 'entitlement.json'), JSON.stringify({ plan: 'free', licenseKey }));
  rmSync(join(getDataDir(), 'auth-signed-out-at'), { force: true });
  allowAccountRefresh();
  publishReadyAccountState(subject, readSignInEpoch()!, licenseKey);
  });
}
function token(subject = accountId, scopes = [PLUGIN_PREPARE_TASK_SCOPE]) {
  return mintPluginToken({ machineId: 'draft-machine', clientId: 'draft-client', accountId: subject, scopes });
}
function request(name: string, args: unknown, bearer = token()) {
  return new NextRequest('http://localhost/api/plugins/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}
async function call(name: string, args: unknown, bearer = token()) {
  const req = request(name, args, bearer);
  expect(panelGateMiddleware(req).status).toBe(200);
  const response = await POST(req);
  return { status: response.status, result: (await response.json()).result.structuredContent };
}
async function options() {
  const value = await call('o8_task_options', { machineId: 'draft-machine', repoId, projectId });
  expect(value.status).toBe(200);
  expect(value.result.ok).toBe(true);
  return value.result;
}
function contract(snapshotId: string) {
  return {
    machineId: 'draft-machine', repoId, projectId, snapshotId, idempotencyKey: 'exact-draft',
    objective: 'Read the fixture and report its contents.', allowedFiles: ['README.md'],
    runtime: fixtureRuntime, model: fixtureRuntime === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6', effort: 'high', workMode: 'read-only',
    evidence: ['Report the exact fixture contents and any residual uncertainty.'],
    sealedTaskContract: {
      version: 1, requirements: [{ id: 'R1', source: 'Explicit task request',
        expectedBehavior: 'Read the fixture.', productionPath: 'README.md', verification: 'Report the observed contents.' }],
      smallestRoute: [{ path: 'README.md', requirements: ['R1'], reason: 'The single requested fixture.' }],
      exclusions: ['No writes or additional worker delegation.'],
    },
  };
}
function git(...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }); }

beforeEach(async () => {
  fixtureChildren.lifetime!.begin();
  vi.restoreAllMocks();
  ready.mockReset().mockResolvedValue(undefined);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  sync.mockImplementation(actual.fsyncSync);
  persistent = true;
  journalDelayMs = 0;
  fixtureRuntime = 'codex';
  ruleHome.path = realpathSync(mkdtempSync(join(tmpdir(), 'o8-task-rules-fixture-')));
  dirs.push(ruleHome.path);
  writeFileSync(join(ruleHome.path, 'AGENTS.md'), 'Global fixture rule: never invent evidence.\n');
  process.env.O8_LICENSE_PUBKEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  rmSync(taskDraftRoot(), { recursive: true, force: true });
  await account();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-plugin-draft-fixture-')));
  dirs.push(repo);
  git('init', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'fixture contents\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Read only; report evidence.\n');
  git('add', 'README.md', 'AGENTS.md');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'fixture');
  repoId = randomUUID();
  fixtureRoot = mkdtempSync(join(getDataDir(), 'task-dispatch-fixture-'));
  dirs.push(fixtureRoot);
  output = join(fixtureRoot, 'runs.jsonl');
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(fixtureRoot, 'sessions');
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = join(fixtureRoot, 'sessions');
  process.env.O8_TASK_DISPATCH_FIXTURE_BIN = process.execPath;
  store = createOwnedSessionStore(adapter());
  registerRuntime({ ...getRuntime('codex')!, launch: async (opts) => {
    const result = await store.launch({ ...opts, runtimeConfig: { workMode: opts.workMode! } });
    return { ok: result.ok, sessionKey: result.surfaceId, note: result.note };
  } });
  registerRuntime({ ...getRuntime('claude-code')!, launch: async (opts) => {
    store = createOwnedSessionStore(adapter());
    const result = await store.launch({ ...opts, runtimeConfig: { workMode: opts.workMode! } });
    return { ok: result.ok, sessionKey: result.surfaceId, note: result.note };
  } });
  const project = createProject({ name: `Task fixture ${randomUUID()}` });
  projectId = project.id;
  addRepoToProject(projectId, repoId);
  writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: repoId, name: 'Task fixture', localPath: repo, remoteUrl: null, defaultBranch: 'main',
    isGitRepo: true, addedAt: new Date().toISOString(), lastOpenedAt: null, storagePressureParkingDisabled: false, setup: {},
  }] }));
  await upsertProjectLedgerRecord({ id: projectId, name: project.name, slug: project.slug, repoPaths: [repo] });
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: 'existing-operator-mission', repoPath: repo, packets: [{
      id: 'existing-packet', referenceLabel: 'P1', title: 'Preserve this task', summary: 'Held by operator', runtime: 'codex',
      workspaceTargetPath: null, branchTarget: 'fixture', dependencyLabels: [], dependencyPacketIds: [],
      status: 'queued', queueState: 'held', releaseState: 'pending', operatorStopped: true,
    }] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  sync.mockImplementation(actual.fsyncSync);
  await fixtureChildren.lifetime!.close();
  expect(fixtureChildren.lifetime!.activeCount(), 'fixture-owned children must exit after teardown').toBe(0);
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = oldOwnedRoot;
  if (oldOwnedRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  if (oldClaudeRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  else process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = oldClaudeRoot;
  if (oldFixtureBinary === undefined) delete process.env.O8_TASK_DISPATCH_FIXTURE_BIN;
  else process.env.O8_TASK_DISPATCH_FIXTURE_BIN = oldFixtureBinary;
});
afterAll(async () => {
  await fixtureChildren.lifetime!.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.O8_LICENSE_PUBKEY; else process.env.O8_LICENSE_PUBKEY = oldKey;
});

function runs(): Array<{ pid: number; cwd: string; model: string; effort: string; prompt: string }> {
  try { return readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function adapter(): OwnedRuntimeAdapter {
  const report = 'Fixture contents verified. sk-abcdefghijklmnopqrstuvwxyz123456 /private/fixture/report.txt https://example.invalid/report?token=private';
  const events = fixtureRuntime === 'codex' ? [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE_THINKING' }] } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'PRIVATE_TOOL', aggregated_output: 'PRIVATE_TOOL_OUTPUT' } },
    { type: 'item.completed', item: { type: 'agent_message', text: report } },
    { type: 'turn.completed' },
  ] : [
    { type: 'assistant', message: { id: 'fixture-answer', role: 'assistant', content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: report }] } },
    { type: 'result', subtype: 'success', is_error: false, result: report },
  ];
  return { runtimeId: fixtureRuntime, surfaceIdPrefix: `${fixtureRuntime}-owned:`,
    rootEnvVar: fixtureRuntime === 'codex' ? 'CORTEX_IDE_OWNED_CODEX_ROOT' : 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
    rootDefault: join(fixtureRoot, 'sessions'), binaryName: 'node', binaryEnvOverride: 'O8_TASK_DISPATCH_FIXTURE_BIN',
    humanLabel: 'Fixture', squadShortName: 'Fixture', workerMcpInjection: 'config-override',
    launchArgs: ({ model, effort, prompt }) => {
      const script = `require('node:fs').appendFileSync(${JSON.stringify(output)}, JSON.stringify({ pid:process.pid,cwd:process.cwd(),model:${JSON.stringify(model)},effort:${JSON.stringify(effort)},prompt:${JSON.stringify(prompt)} })+${JSON.stringify('\n')}); ${persistent ? 'setInterval(()=>{},1000)' : `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n')}); process.exit(0)`}`;
      return ['-e', journalDelayMs ? `setTimeout(() => { ${script} }, ${journalDelayMs}); setInterval(()=>{},1000);` : script];
    },
    resumeArgs: () => [], parseRunLog: () => ({ entries: [], outcome: persistent ? 'running' : 'finished', completedTurn: !persistent }) };
}
async function prepare() {
  const result = await call('o8_prepare_task', contract((await options()).snapshotId));
  expect(result.result.ok).toBe(true);
  return listTaskDrafts(accountId)[0]!;
}
async function decision(draft: Awaited<ReturnType<typeof prepare>>, action = 'launch', bearer = getOrCreateWsToken(), extra = {}) {
  const request = new NextRequest('http://localhost/api/plugins/task-drafts/control', { method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, taskId: draft.taskId, contractHash: draft.contractHash, ...extra }) });
  const response = await control(request);
  return { status: response.status, body: await response.json(), middleware: panelGateMiddleware(request).status };
}
function executionFile(draft: Awaited<ReturnType<typeof prepare>>) { return join(taskDraftRoot(), 'executions', `${draft.taskId}.json`); }
function savedSession(): OwnedSessionRecord {
  const root = join(fixtureRoot, 'sessions');
  return JSON.parse(readFileSync(join(root, readdirSync(root)[0]!, 'session.json'), 'utf8'));
}
function cold(draft: Awaited<ReturnType<typeof prepare>>) {
  const entry = join(fixtureRoot, 'cold.cjs');
  buildSync({ entryPoints: ['tests/fixtures/task-execution-store-child.fixture.ts'], outfile: entry,
    platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', external: ['better-sqlite3'],
    alias: { 'server-only': join(process.cwd(), 'tests/stubs/server-only.ts') } });
  return JSON.parse(execFileSync(process.execPath, [entry, 'read', draft.taskId, accountId],
    { encoding: 'utf8', env: { ...process.env, CORTEX_IDE_DATA_DIR: getDataDir(), NODE_PATH: join(process.cwd(), 'node_modules') } }));
}

describe('controlled tasks through the operator route, durable intent and owned child', () => {
  const taskResult = (taskId: string, bearer = token(accountId, ['o8:read'])) => call('o8_task_result', {
    machineId: 'draft-machine', taskId,
  }, bearer);

  it('owns a dispatched worker before its journal row exists', async () => {
    journalDelayMs = 60_000;
    const draft = await prepare();
    expect((await decision(draft)).status).toBe(200);
    expect(fixtureChildren.lifetime!.activeCount()).toBeGreaterThan(0);
    expect(runs()).toHaveLength(0);
    // afterEach must stop this real child even though runs.jsonl has no PID.
  });

  it('delivers admitted applicable rules to the actual child without adding them to hosted receipts', async () => {
    mkdirSync(join(repo, 'unrelated'));
    writeFileSync(join(repo, 'unrelated', 'AGENTS.md'), 'Unrelated private rule.\n');
    git('add', 'unrelated/AGENTS.md');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'unrelated scoped rules');
    const draft = await prepare();
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0]!.prompt).toContain('Global fixture rule: never invent evidence.');
    expect(runs()[0]!.prompt).toContain('Read only; report evidence.');
    expect(runs()[0]!.prompt).not.toContain('Unrelated private rule.');
    expect(savedSession().controlledTask).toMatchObject({ contractHash: draft.contractHash });
    const hosted = await taskResult(draft.taskId);
    expect(JSON.stringify(hosted)).not.toContain('Global fixture rule');
    expect(JSON.stringify(hosted)).not.toContain(ruleHome.path);
    await decision(draft, 'stop');
  });

  it('refuses changed global rules before child creation instead of sending stale instruction text', async () => {
    const draft = await prepare();
    writeFileSync(join(ruleHome.path, 'AGENTS.md'), 'Changed global instructions.\n');
    const refused = await decision(draft);
    expect(refused.status).toBe(409);
    expect(runs()).toHaveLength(0);
    expect(readTaskExecution(draft)).toBeNull();
  });

  it('refuses dangling global instruction links at the actual preparation route', async () => {
    rmSync(join(ruleHome.path, 'AGENTS.md'));
    symlinkSync(join(ruleHome.path, 'missing-rules.md'), join(ruleHome.path, 'AGENTS.md'));
    const result = await call('o8_task_options', { machineId: 'draft-machine', repoId, projectId });
    expect(result.status).toBe(409);
    expect(result.result.code).toBe('rules_unavailable');
    expect(listTaskDrafts(accountId)).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  it('delivers directory rules for an admitted nested file and rejects oversized applicable rules before spawn', async () => {
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, 'nested', 'AGENTS.md'), 'Nested applicable fixture rule.\n');
    writeFileSync(join(repo, 'nested', 'value.txt'), 'nested fixture\n');
    git('add', 'nested');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'nested scoped rules');
    const args = contract((await options()).snapshotId);
    args.allowedFiles = ['nested/value.txt'];
    args.sealedTaskContract.requirements[0]!.productionPath = 'nested/value.txt';
    args.sealedTaskContract.smallestRoute[0]!.path = 'nested/value.txt';
    expect((await call('o8_prepare_task', args)).status).toBe(200);
    const draft = listTaskDrafts(accountId)[0]!;
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0]!.prompt).toContain('Nested applicable fixture rule.');
    expect(runs()[0]!.prompt.indexOf('Global fixture rule')).toBeLessThan(runs()[0]!.prompt.indexOf('Nested applicable fixture rule'));
    await decision(draft, 'stop');

    writeFileSync(join(ruleHome.path, 'AGENTS.md'), 'x'.repeat(64_001));
    const large = await call('o8_prepare_task', { ...contract((await options()).snapshotId), idempotencyKey: 'large-rules' });
    expect(large.status).toBe(200);
    const oversized = listTaskDrafts(accountId).find((entry) => entry.contract.idempotencyKey === 'large-rules')!;
    const refused = await decision(oversized);
    expect(refused.body.execution.state).toBe('blocked');
    expect(readTaskExecution(oversized)!.surfaceId).toBeUndefined();
    expect(runs()).toHaveLength(1);
  });

  it.each(['codex', 'claude-code'] as const)('returns only the bound %s final report through the read-only hosted route', async (runtime) => {
    fixtureRuntime = runtime;
    persistent = false;
    const draft = await prepare();
    expect((await taskResult(draft.taskId)).result).toMatchObject({ state: 'held', completed: false,
      completion: { available: false, reason: 'not_launched' } });
    await decision(draft);
    await vi.waitFor(async () => expect((await decision(draft, 'inspect')).body.execution.state).toBe('completed'), completionPoll);
    const before = readFileSync(executionFile(draft), 'utf8');
    const result = await taskResult(draft.taskId);
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ ok: true, taskId: draft.taskId, state: 'completed', completed: true,
      runtime, model: draft.contract.model, effort: 'high', reviewRequired: true, retryAllowed: false,
      completion: { available: true, source: 'worker_report' } });
    expect(result.result.completion.summary).toContain('Fixture contents verified.');
    const exposed = JSON.stringify(result.result);
    for (const privateText of ['PRIVATE_THINKING', 'PRIVATE_TOOL', 'abcdefghijklmnopqrstuvwxyz123456',
      '/private/fixture', '?token=', draft.contract.objective, readTaskExecution(draft)!.workspacePath]) {
      expect(exposed).not.toContain(privateText);
    }
    expect(readFileSync(executionFile(draft), 'utf8')).toBe(before);
    expect(runs()).toHaveLength(1);
    const secondClient = mintPluginToken({ machineId: 'draft-machine', clientId: 'second-official-client',
      accountId, scopes: ['o8:read'] });
    expect((await taskResult(draft.taskId, secondClient)).result.completion.available).toBe(true);
    expect((await store.archiveSession(savedSession().surfaceId)).archived).toBe(true);
    expect((await taskResult(draft.taskId)).result).toMatchObject({ state: 'completed', completed: true,
      completion: { available: true } });
    expect((await taskResult(draft.taskId, token())).status).toBe(403);
    expect((await taskResult(draft.taskId, token('user_foreign', ['o8:read']))).status).toBe(403);
    expect((await taskResult(draft.taskId, mintPluginToken({ machineId: 'other-machine', clientId: 'draft-client',
      accountId, scopes: ['o8:read'] }))).status).toBe(403);
    expect((await taskResult(draft.taskId, mintPluginToken({ machineId: 'draft-machine', clientId: 'draft-client',
      scopes: ['o8:read'] }))).status).toBe(403);
    expect((await taskResult(randomUUID())).status).toBe(404);
    await account(); // Same user, different sign-in generation cannot expose an old draft.
    expect((await taskResult(draft.taskId)).status).toBe(404);
  }, 20_000);

  it('reads running and stopped receipts without controlling the worker or publishing a false report', async () => {
    const draft = await prepare();
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect((await taskResult(draft.taskId)).result).toMatchObject({ state: 'running', completed: false,
      completion: { available: false } });
    expect(() => process.kill(runs()[0]!.pid, 0)).not.toThrow();
    await decision(draft, 'stop');
    expect((await taskResult(draft.taskId)).result).toMatchObject({ state: 'stopped', completed: false,
      completion: { available: false } });
    expect(runs()).toHaveLength(1);
  }, 20_000);

  it.each(['binding', 'path', 'symlink', 'missing-log', 'missing-receipt', 'multiple-runs', 'missing-terminal', 'oversized'] as const)(
    'returns uncertainty or failure for %s evidence through the actual hosted route', async (kind) => {
      persistent = false;
      const draft = await prepare();
      await decision(draft);
      await vi.waitFor(async () => expect((await decision(draft, 'inspect')).body.execution.state).toBe('completed'), completionPoll);
      const session = savedSession();
      const run = session.recentRuns[0]!;
      if (kind === 'binding') session.controlledTask!.attemptId = randomUUID();
      if (kind === 'path') run.stdoutPath = join(repo, 'README.md');
      if (kind === 'multiple-runs') session.runIdentityLedger!.totalRuns = 2;
      if (kind === 'symlink') { rmSync(run.stdoutPath); symlinkSync(join(repo, 'README.md'), run.stdoutPath); }
      if (kind === 'missing-log') rmSync(run.stdoutPath);
      if (kind === 'missing-receipt') rmSync(executionFile(draft));
      if (kind === 'missing-terminal') writeFileSync(run.stdoutPath, JSON.stringify({ type: 'item.completed',
        item: { type: 'agent_message', text: 'Not a completed result.' } }));
      if (kind === 'oversized') writeFileSync(run.stdoutPath, 'x'.repeat(4_194_305));
      writeFileSync(join(session.sessionDir, 'session.json'), JSON.stringify(session));
      const result = await taskResult(draft.taskId);
      expect(result.status).toBe(200);
      expect(result.result).toMatchObject({ completed: false, completion: { available: false } });
      expect(result.result.state).toBe(kind === 'missing-terminal' ? 'blocked' : 'uncertain');
      expect(JSON.stringify(result.result)).not.toContain('Fixture contents verified.');
      expect(runs()).toHaveLength(1);
    }, 20_000);

  it.each(['running', 'completed'] as const)('reports persisted %s execution on an exact hosted preparation retry without another child', async (state) => {
    persistent = state === 'running';
    const args = contract((await options()).snapshotId);
    const prepared = await call('o8_prepare_task', args);
    expect(prepared.result).toMatchObject({ state: 'held', dispatched: false, completed: false });
    const draft = listTaskDrafts(accountId)[0]!;
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    if (state === 'completed') {
      await vi.waitFor(async () => expect((await decision(draft, 'inspect')).body.execution.state).toBe('completed'), completionPoll);
    }
    const execution = readTaskExecution(draft)!;
    const replay = await call('o8_prepare_task', args);
    expect(replay.result).toMatchObject({ ok: true, accepted: true, taskId: draft.taskId,
      replayed: true, state, dispatched: true, completed: state === 'completed',
      executionEnabled: false, executionEvidence: 'persisted', attemptId: execution.attemptId });
    expect(replay.result.message).not.toContain('No worker has started');
    expect(JSON.stringify(replay.result)).not.toContain(execution.workspacePath);
    expect(runs()).toHaveLength(1);
    expect(listTaskDrafts(accountId)).toHaveLength(1);
    expect(readTaskExecution(draft)!.attemptId).toBe(execution.attemptId);
    const conflict = await call('o8_prepare_task', { ...args, objective: 'Different task.' });
    expect(conflict.result.code).toBe('idempotency_key_conflict');
    expect(conflict.result.message).not.toContain('No worker started');
    expect(runs()).toHaveLength(1);
    await account('user_other_account');
    expect((await call('o8_prepare_task', args)).status).toBe(403);
  });

  it('reports uncertainty after a reserved execution loses its receipt instead of claiming no worker started', async () => {
    const args = contract((await options()).snapshotId);
    await call('o8_prepare_task', args);
    const draft = listTaskDrafts(accountId)[0]!;
    await reserveTaskExecution(draft);
    rmSync(executionFile(draft));
    const replay = await call('o8_prepare_task', args);
    expect(replay.result).toMatchObject({ ok: true, accepted: true, taskId: draft.taskId,
      replayed: true, state: 'uncertain', dispatched: null, completed: false,
      executionEnabled: false, executionEvidence: 'unavailable', errorCode: 'execution_uncertain' });
    expect(replay.result.message).not.toContain('No worker has started');
    expect(runs()).toHaveLength(0);
  });

  it('lists exact operator contract bindings and safe permanent receipts without workspace paths', async () => {
    const draft = await prepare();
    const request = () => new NextRequest('http://localhost/api/plugins/task-drafts', {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    });
    let response = await inspectDrafts(request());
    expect(response.headers.get('cache-control')).toBe('no-store');
    let body = await response.json();
    expect(body.accountId).toBe(accountId);
    expect(body.drafts[0]).toMatchObject({ contractHash: draft.contractHash, execution: null, executionError: null });
    await decision(draft);
    response = await inspectDrafts(request());
    body = await response.json();
    expect(body.drafts[0].execution).toMatchObject({ contractHash: draft.contractHash, state: 'running', retryAllowed: false });
    expect(JSON.stringify(body)).not.toContain('workspacePath');
    const denied = await inspectDrafts(new NextRequest('http://localhost/api/plugins/task-drafts'));
    expect(denied.status).toBe(401);
    await account();
    body = await (await inspectDrafts(request())).json();
    expect(body.drafts[0].sessionCurrent).toBe(false);
  });

  it('starts one isolated child for concurrent decisions and recovers a cold/lost-reply receipt without a new attempt', async () => {
    const draft = await prepare();
    const mission = readOrchestratorMissionState();
    const synced = new Set<string>();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    sync.mockImplementation((fd: number) => {
      const entry = fstatSync(fd);
      if (entry.isDirectory()) {
        for (const path of [taskDraftRoot(), getDataDir(), join(taskDraftRoot(), 'executions'), join(taskDraftRoot(), 'execution-reservations')]) {
          if (existsSync(path) && statSync(path).dev === entry.dev && statSync(path).ino === entry.ino) synced.add(path);
        }
      }
      actual.fsyncSync(fd);
    });
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${join(fixtureRoot, 'hook-ran')}'\n`, { mode: 0o700 });
    const results = await Promise.all([decision(draft), decision(draft)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(new Set(results.map((result) => result.body.execution.attemptId)).size).toBe(1);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(synced.size).toBe(4);
    const execution = readTaskExecution(draft)!;
    expect(runs()[0]).toMatchObject({ cwd: execution.workspacePath, model: draft.contract.model, effort: draft.contract.effort });
    expect(execution.workspacePath).not.toBe(repo);
    expect(git('rev-parse', 'HEAD').trim()).toBe(draft.snapshot.revision);
    expect(existsSync(join(fixtureRoot, 'hook-ran'))).toBe(false);
    expect(savedSession()).toMatchObject({ controlledTask: { taskId: draft.taskId, attemptId: execution.attemptId,
      contractHash: draft.contractHash }, runIdentityLedger: { totalRuns: 1 }, executionPolicy: { mode: 'single-attempt' } });
    expect(cold(draft)).toMatchObject({ attemptId: execution.attemptId, state: 'running', surfaceId: savedSession().surfaceId });
    expect((await decision(draft)).body.execution).toMatchObject({ attemptId: execution.attemptId, replayed: true, retryAllowed: false });
    expect(runs()).toHaveLength(1);
    expect((await store.archiveSession(savedSession().surfaceId)).archived).toBe(false);
    expect(readOrchestratorMissionState()).toEqual(mission);
    await expect(store.resume(savedSession().surfaceId, 'repeat')).rejects.toThrow(/single.attempt/i);
  }, 20_000);

  it('denies hosted grants, wrong contracts, foreign accounts, and review/merge/release actions before effects', async () => {
    const draft = await prepare();
    for (const scopes of [['o8:read'], ['o8:read', 'o8:follow-up'], [PLUGIN_PREPARE_TASK_SCOPE]]) {
      const result = await decision(draft, 'launch', token(accountId, scopes));
      expect(result.status).toBe(403);
      expect(result.middleware).toBe(403);
    }
    expect((await decision(draft, 'launch', getOrCreateWsToken(), { contractHash: 'f'.repeat(64) })).status).toBe(409);
    for (const action of ['approve', 'merge', 'release', 'resume']) expect((await decision(draft, action)).status).toBe(400);
    await account('user_fixture_foreign');
    expect((await decision(draft)).status).toBe(404);
    expect(existsSync(executionFile(draft))).toBe(false);
    expect(runs()).toHaveLength(0);
  });

  it('executes no configured filters, index/checkout hooks, or filesystem monitor during prepare and checkout', async () => {
    const sentinel = join(fixtureRoot, 'configured-command-ran');
    writeFileSync(join(repo, '.gitattributes'), 'README.md filter=fixture\n');
    git('add', '.gitattributes');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'fixture attributes');
    for (const kind of ['clean', 'smudge', 'process']) git('config', `filter.fixture.${kind}`, `touch '${sentinel}'; cat`);
    git('config', 'filter.fixture.required', 'true');
    const monitor = join(fixtureRoot, 'monitor.sh');
    writeFileSync(monitor, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
    git('config', 'core.fsmonitor', monitor);
    for (const name of ['post-index-change', 'post-checkout']) {
      writeFileSync(join(repo, '.git', 'hooks', name), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
    }
    writeFileSync(join(repo, 'README.md'), 'fixture contents\n'); // Force a freshness stat/content check.
    const draft = await prepare();
    const result = await decision(draft);
    expect(result.body.execution.state).toBe('running');
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(existsSync(sentinel)).toBe(false);
  }, 20_000);

  it.each(['sign-out', 'account-switch', 'rules', 'global-rules', 'workspace', 'binding'] as const)(
    'refuses %s changes during backend preparation before actual spawn', async (kind) => {
      const draft = await prepare();
      ready.mockImplementationOnce(async () => {
        if (kind === 'sign-out') await withAccountStateLease(() => {
          holdAccountRefresh(); writeFileSync(join(getDataDir(), 'auth-signed-out-at'), String(Date.now()));
        });
        if (kind === 'account-switch') await account('user_fixture_foreign');
        if (kind === 'rules') writeFileSync(join(repo, 'AGENTS.md'), 'Changed rules\n');
        if (kind === 'global-rules') writeFileSync(join(ruleHome.path, 'AGENTS.md'), 'Changed global rules\n');
        if (kind === 'workspace') writeFileSync(join(readTaskExecution(draft)!.workspacePath, 'README.md'), 'Changed checkout\n');
        if (kind === 'binding') {
          const root = join(fixtureRoot, 'sessions');
          const file = join(root, readdirSync(root)[0]!, 'session.json');
          const session = savedSession(); delete session.controlledTask;
          writeFileSync(file, JSON.stringify(session));
        }
      });
      await decision(draft);
      expect(ready).toHaveBeenCalledOnce();
      expect(runs()).toHaveLength(0);
      const before = readTaskExecution(draft)!;
      expect(before.state).toBe('blocked');
      if (kind !== 'sign-out' && kind !== 'account-switch') {
        expect((await decision(draft)).body.execution).toMatchObject({ attemptId: before.attemptId, retryAllowed: false, state: 'blocked' });
        expect((await call('o8_prepare_task', draft.contract)).result).toMatchObject({
          taskId: draft.taskId, state: 'blocked', dispatched: false, completed: false, replayed: true,
        });
        expect(runs()).toHaveLength(0);
      }
    }, 20_000);

  it('preserves a published acceptance after directory sync uncertainty and never retries it', async () => {
    const draft = await prepare();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    sync.mockImplementation((fd: number) => {
      if (existsSync(executionFile(draft))) throw new Error('Fixture publication uncertainty');
      actual.fsyncSync(fd);
    });
    expect((await decision(draft)).status).toBe(503);
    sync.mockImplementation(actual.fsyncSync);
    const original = cold(draft);
    expect((await decision(draft)).body.execution).toMatchObject({ attemptId: original.attemptId, state: 'accepted', replayed: true });
    expect(runs()).toHaveLength(0);
    rmSync(executionFile(draft));
    expect((await decision(draft)).body.error).toBe('execution_uncertain');
    expect(runs()).toHaveLength(0);
  });

  it('holds an abandoned reservation or corrupt execution evidence without replenishing the attempt', async () => {
    const draft = await prepare();
    await reserveTaskExecution(draft);
    writeFileSync(executionFile(draft), '{}');
    expect((await decision(draft)).status).toBe(409);
    rmSync(executionFile(draft));
    expect((await decision(draft)).status).toBe(409);
    expect(runs()).toHaveLength(0);
  });

  it('persists Stop during preparation and prevents the later spawn', async () => {
    const draft = await prepare();
    let release!: () => void;
    ready.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const launching = decision(draft);
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalled(), { timeout: 5000 });
      const stop = await decision(draft, 'stop');
      expect(stop.body.execution.state).toBe('stop_requested');
      expect(cold(draft).stopRequestedAt).toBeTruthy();
    } finally { release?.(); }
    await launching;
    expect(runs()).toHaveLength(0);
    expect((await decision(draft)).body.execution.state).toBe('stop_requested');
  }, 20_000);

  it('holds an independent account writer through final journal publication and actual spawn', async () => {
    const draft = await prepare();
    // Compile before admission so the probe has no build work inside the lease.
    const entry = join(fixtureRoot, 'cold.cjs');
    buildSync({ entryPoints: ['tests/fixtures/task-execution-store-child.fixture.ts'], outfile: entry,
      platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', external: ['better-sqlite3'],
    alias: { 'server-only': join(process.cwd(), 'tests/stubs/server-only.ts') } });
    const probe = () => JSON.parse(execFileSync(process.execPath, [entry, 'account-write', draft.taskId, accountId], {
      timeout: 15_000, encoding: 'utf8', env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') } }));
    let inspected = false;
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    sync.mockImplementation((fd: number) => {
      if (!inspected && existsSync(executionFile(draft)) && readTaskExecution(draft)?.state === 'spawn_reserved'
        && savedSession().activeRun?.spawnState === 'prepared') {
        inspected = true;
        expect(runs()).toHaveLength(0);
        expect(probe()).toEqual({ blocked: true });
      }
      actual.fsyncSync(fd);
    });
    const result = await decision(draft);
    sync.mockImplementation(actual.fsyncSync);
    expect(result.body.execution.state).toBe('running');
    expect(inspected).toBe(true);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(probe()).toEqual({ acquired: true });
    expect((await decision(draft, 'stop')).body.execution.state).toBe('stopped');
  }, 30_000);

  it('publishes Stop before any signal, revokes its credential and proves the actual child exited', async () => {
    const draft = await prepare();
    expect((await decision(draft)).status).toBe(200);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    const kill = process.kill.bind(process);
    let sent = false;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal && signal !== 0 && [runs()[0]!.pid, -runs()[0]!.pid].includes(pid)) {
        expect(readTaskExecution(draft)!.stopRequestedAt).toBeTruthy();
        sent = true;
      }
      return kill(pid, signal);
    });
    const stop = await decision(draft, 'stop');
    expect(sent).toBe(true);
    expect(stop.body.execution).toMatchObject({ state: 'stopped', stopped: true, reviewRequired: true });
    expect(() => kill(runs()[0]!.pid, 0)).toThrow();
    expect((await decision(draft)).body.execution).toMatchObject({ state: 'stopped', retryAllowed: false });
    expect(runs()).toHaveLength(1);
  }, 20_000);

  it.each(['sign-out', 'expired-license', 'fresh-sign-in'] as const)('keeps exact operator Stop available after %s', async (kind) => {
    const draft = await prepare();
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    if (kind === 'sign-out') await withAccountStateLease(() => {
      holdAccountRefresh(); writeFileSync(join(getDataDir(), 'auth-signed-out-at'), String(Date.now()));
      clearActiveIdentity();
    });
    if (kind === 'expired-license') await account(accountId, -1);
    if (kind === 'fresh-sign-in') {
      await account('user_fixture_foreign');
      expect((await decision(draft, 'stop')).status).toBe(404);
      expect(() => process.kill(runs()[0]!.pid, 0)).not.toThrow();
      await account();
    }
    expect((await decision(draft, 'launch')).status).toBe(403);
    expect((await decision(draft, 'stop')).body.execution).toMatchObject({ state: 'stopped', stopped: true });
    expect(() => process.kill(runs()[0]!.pid, 0)).toThrow();
  }, 20_000);

  it('recovers a proven dead process lease after crash and retains the original attempt for Stop', async () => {
    const draft = await prepare();
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    const before = cold(draft);
    const child = spawn(process.execPath, [join(fixtureRoot, 'cold.cjs'), 'lock', draft.taskId, accountId], {
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', (value) => { text += String(value); });
    try { await vi.waitFor(() => expect(text).toContain('locked')); }
    finally { child.kill('SIGKILL'); }
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect((await decision(draft, 'inspect')).body.execution).toMatchObject({ attemptId: before.attemptId, state: 'running' });
    expect((await decision(draft, 'stop')).body.execution).toMatchObject({ attemptId: before.attemptId, state: 'stopped' });
    expect(runs()).toHaveLength(1);
  }, 20_000);

  it('keeps inspect and Stop reachable after an independent database writer contends across lease release', async () => {
    const draft = await prepare();
    await decision(draft);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    const original = cold(draft);
    let child!: ReturnType<typeof spawn>;
    let childClosed!: Promise<void>;
    await withTaskExecutionLock(draft.taskId, async () => {
      child = spawn(process.execPath, [join(fixtureRoot, 'cold.cjs'), 'database-write-lock', draft.taskId, accountId], {
        env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
      childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let text = ''; child.stdout!.on('data', (value) => { text += String(value); });
      await vi.waitFor(() => expect(text).toContain('database-locked'), { timeout: 5000 });
    });
    await childClosed;
    expect((await decision(draft, 'inspect')).body.execution).toMatchObject({ attemptId: original.attemptId, state: 'running' });
    expect((await decision(draft, 'stop')).body.execution).toMatchObject({ attemptId: original.attemptId, state: 'stopped' });
    expect(runs()).toHaveLength(1);
  }, 25_000);

  it('requires operator review after a real clean exit and gives completion no extra authority', async () => {
    const draft = await prepare(); persistent = false;
    expect((await decision(draft)).status).toBe(200);
    await vi.waitFor(() => expect(savedSession().recentRuns[0]?.childExit?.classification).toBe('clean-exit'));
    const inspected = await decision(draft, 'inspect');
    expect(inspected.body.execution).toMatchObject({ completed: true, state: 'completed', reviewRequired: true });
    expect((await decision(draft, 'approve')).status).toBe(400);
    expect((await store.archiveSession(savedSession().surfaceId)).archived).toBe(true);
    expect((await decision(draft)).body.execution.attemptId).toBe(inspected.body.execution.attemptId);
    expect(runs()).toHaveLength(1);
  }, 20_000);
});
