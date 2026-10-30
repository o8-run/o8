import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { buildSync } from 'esbuild';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launches = vi.hoisted(() => vi.fn(async () => ({ ok: false, note: 'No launch expected' })));
// Native worker execution is the external boundary. Routes, account signatures,
// repository/project membership, Git, persistence and headless ticks are real.
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface: launches }));

import { POST } from '@/app/api/plugins/mcp/route';
import { GET as inspectDrafts } from '@/app/api/plugins/task-drafts/route';
import { mintPluginToken, PLUGIN_PREPARE_TASK_SCOPE, resolvePluginToken } from '@/lib/auth/plugin-token';
import { parsePluginRelayGrant, pluginReplayAuthorization } from '@/lib/connect/plugin-relay';
import { publishReadyAccountState, withAccountStateLease } from '@/lib/auth/account-state';
import { getDataDir } from '@/lib/data-dir-migration';
import { bumpSignInEpoch, readSignInEpoch, writeActiveIdentity } from '@/lib/github-broker/managed';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';
import { contractHash, listTaskDrafts, readTaskDraft, taskDraftKey, taskDraftRoot, withTaskDraftLock } from '@/lib/mcp/task-draft-store';
import * as workspace from '@/lib/mcp/task-draft-workspace';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { runHeadlessSprintTick } from '@/lib/orchestrator/headless-loop';
import { createEmptyOrchestratorMissionState, readOrchestratorMissionState } from '@/lib/orchestrator/store';
import { addRepoToProject, createProject } from '@/lib/projects/store';
import { upsertProjectLedgerRecord } from '@/lib/repos/projects';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { panelGateMiddleware } from '@/middleware';
import { TASK_DRAFT_TOOLS } from '@/lib/mcp/task-draft-tools';

const keys = generateKeyPairSync('ed25519');
const oldKey = process.env.O8_LICENSE_PUBKEY;
const dirs: string[] = [];
let repo: string;
let projectId: string;
let projectName: string;
let repoId: string;
const accountId = 'user_fixture_task_draft';
const execAsync = promisify(execFile);

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
async function discover(bearer = token(accountId, ['o8:read', 'o8:follow-up', PLUGIN_PREPARE_TASK_SCOPE])) {
  const request = new NextRequest('http://localhost/api/plugins/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'catalog', method: 'tools/list' }),
  });
  expect(panelGateMiddleware(request).status).toBe(200);
  const response = await POST(request);
  return { status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') };
}
function contract(snapshotId: string) {
  return {
    machineId: 'draft-machine', repoId, projectId, snapshotId, idempotencyKey: 'exact-draft',
    objective: 'Read the fixture and report its contents.', allowedFiles: ['README.md'],
    runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', workMode: 'read-only',
    evidence: ['Report the exact fixture contents and any residual uncertainty.'],
    sealedTaskContract: {
      version: 1, requirements: [{ id: 'R1', source: 'Explicit task request',
        expectedBehavior: 'Read the fixture.', productionPath: 'README.md', verification: 'Report the observed contents.' }],
      smallestRoute: [{ path: 'README.md', requirements: ['R1'], reason: 'The single requested fixture.' }],
      exclusions: ['No writes or dispatch.'],
    },
  };
}
function intents() {
  const dir = join(taskDraftRoot(), 'intents');
  try { return readdirSync(dir).filter((file) => file.endsWith('.json')); } catch { return []; }
}
function git(...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }); }

beforeEach(async () => {
  vi.restoreAllMocks();
  launches.mockClear();
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
  const project = createProject({ name: `Task fixture ${randomUUID()}` });
  projectId = project.id;
  projectName = project.name;
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
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.O8_LICENSE_PUBKEY; else process.env.O8_LICENSE_PUBKEY = oldKey;
});

describe('plugin task drafts through the actual authenticated route and persisted state', () => {
  it('refreshes discovery and drops only obsolete preparation snapshots for this app connection', async () => {
    const selected = await options();
    const prepared = await call('o8_prepare_task', contract(selected.snapshotId));
    const held = listTaskDrafts(accountId)[0];
    const source = join(taskDraftRoot(), 'snapshots', `${selected.snapshotId}.json`);
    const snapshot = JSON.parse(readFileSync(source, 'utf8'));
    const seed = (changes: Record<string, unknown>) => {
      const snapshotId = randomUUID();
      const file = join(taskDraftRoot(), 'snapshots', `${snapshotId}.json`);
      writeFileSync(file, JSON.stringify({ ...snapshot, snapshotId, ...changes }));
      return file;
    };
    const stale = seed({ catalogRevision: 'obsolete' });
    const legacy = seed({ catalogRevision: undefined });
    const oldEpoch = seed({ epoch: 'obsolete' });
    const foreignClient = seed({ clientId: 'another-app', catalogRevision: 'obsolete' });
    const foreignAccount = seed({ accountId: 'user_another_account', catalogRevision: 'obsolete' });
    const foreignMachine = seed({ machineId: 'another-machine', catalogRevision: 'obsolete' });
    expect((await discover(token('user_another_account'))).status).toBe(403);
    expect(existsSync(stale)).toBe(true);
    const readOnly = await discover(token(accountId, ['o8:read']));
    expect(readOnly.status).toBe(200);
    expect(readOnly.body.result.tools.some((tool: { name: string }) => tool.name === 'o8_prepare_task')).toBe(false);
    expect(existsSync(stale)).toBe(true);

    const current = await discover();
    expect(current.status).toBe(200);
    expect(current.cacheControl).toBe('no-store');
    expect(current.body.result).toMatchObject({ catalogRevision: snapshot.catalogRevision, preparationSnapshotsInvalidated: 3 });
    expect(current.body.result.catalogRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(current.body.result.tools).toHaveLength(7);
    for (const tool of TASK_DRAFT_TOOLS) expect(current.body.result.tools).toContainEqual(tool);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(oldEpoch)).toBe(false);
    for (const file of [source, foreignClient, foreignAccount, foreignMachine]) expect(existsSync(file)).toBe(true);
    expect(listTaskDrafts(accountId)).toEqual([held]);
    expect((await call('o8_prepare_task', contract(selected.snapshotId))).result)
      .toMatchObject({ taskId: prepared.result.taskId, replayed: true, state: 'held', dispatched: false });
    expect(launches).not.toHaveBeenCalled();
  });

  it('retains the discovered bounded provider contract in one held task without launching', async () => {
    const selected = await options();
    const discovery = await discover();
    expect(discovery.status).toBe(200);
    const preparation = discovery.body.result.tools.find((tool: { name: string }) => tool.name === 'o8_prepare_task');
    const runtime = selected.runtimes.find((row: { models: Array<{ provider?: unknown }> }) => row.models.some((model) => model.provider));
    const offered = runtime.models.find((model: { provider?: unknown }) => model.provider);
    for (const [field, value] of Object.entries(offered.provider)) {
      expect(preparation.inputSchema.properties.provider.properties[field].enum).toEqual([value]);
      expect(preparation.inputSchema.properties.provider.required).toContain(field);
    }
    const args = { ...contract(selected.snapshotId), runtime: runtime.runtime, model: offered.model,
      effort: offered.efforts[0], provider: offered.provider };
    expect((await call('o8_prepare_task', { ...args, provider: undefined })).result.ok).toBe(false);
    expect((await call('o8_prepare_task', { ...args, provider: { ...offered.provider, maxRequests: 5 } })).result.ok).toBe(false);
    const prepared = await call('o8_prepare_task', args);
    expect(prepared.result).toMatchObject({ ok: true, state: 'held', provider: offered.provider, dispatched: false });
    expect(listTaskDrafts(accountId)).toHaveLength(1);
    expect(listTaskDrafts(accountId)[0].contract.provider).toEqual(offered.provider);
    expect(await runHeadlessSprintTick()).toMatchObject({ launched: 0 });
    expect(launches).not.toHaveBeenCalled();
  });

  it('refuses a stale preparation catalog before persisting a new task even without rediscovery', async () => {
    const selected = await options();
    const file = join(taskDraftRoot(), 'snapshots', `${selected.snapshotId}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), catalogRevision: 'obsolete' }));
    expect((await call('o8_prepare_task', contract(selected.snapshotId))).result.code).toBe('snapshot_unavailable');
    expect(intents()).toHaveLength(0);
    expect(launches).not.toHaveBeenCalled();
  });

  it('prepares one held draft, preserves existing work, and launches nothing on headless ticks', async () => {
    const before = readOrchestratorMissionState();
    const choice = await call('o8_task_options', { machineId: 'draft-machine' });
    expect(choice.result.choices).toContainEqual({ repoId, repository: 'Task fixture', projectId, project: projectName });
    const selected = await options();
    const prepared = await call('o8_prepare_task', contract(selected.snapshotId));
    expect(prepared.result).toMatchObject({ ok: true, accepted: true, state: 'held', executionEnabled: false,
      dispatched: false, completed: false, replayed: false, runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(readOrchestratorMissionState()).toEqual(before);
    expect(intents()).toHaveLength(1);
    const persisted = listTaskDrafts(accountId)[0];
    expect(persisted.policy).toEqual({ automaticDispatch: false, workMode: 'read-only', packetCount: 1,
      maxAttempts: 1, fallback: false, executionCarrier: null });
    expect(persisted.contractHash).toBe(contractHash(persisted.contract));
    expect(statSync(join(taskDraftRoot(), 'intents', intents()[0])).mode & 0o777).toBe(0o600);
    const inspected = await inspectDrafts(new Request('http://localhost/api/plugins/task-drafts',
      { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } }));
    expect((await inspected.json()).drafts[0]).toMatchObject({ taskId: prepared.result.taskId, executionEnabled: false });
    expect(await runHeadlessSprintTick()).toMatchObject({ launched: 0 });
    expect(await runHeadlessSprintTick()).toMatchObject({ launched: 0 });
    expect(launches).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared.result)).not.toContain(repo);
    const audit = readPluginAudit();
    expect(audit.some((entry) => entry.taskId === prepared.result.taskId)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('Read the fixture');
  });

  it('distinguishes canonical project labels for one repository before a name-selected held draft', async () => {
    const alternate = createProject({ name: 'Alternate fixture project' });
    addRepoToProject(alternate.id, repoId);
    await upsertProjectLedgerRecord({ id: alternate.id, name: alternate.name, slug: alternate.slug, repoPaths: [repo] });
    const listed = await call('o8_task_options', { machineId: 'draft-machine' });
    expect(listed.result.selectionGuidance).toContain('Mentioning the o8 app does not select a repository');
    expect(listed.result.choices).toEqual(expect.arrayContaining([
      { repoId, repository: 'Task fixture', projectId, project: projectName },
      { repoId, repository: 'Task fixture', projectId: alternate.id, project: alternate.name },
    ]));
    expect(JSON.stringify(listed.result)).not.toContain(repo);
    expect(intents()).toHaveLength(0);
    expect(launches).not.toHaveBeenCalled();
    const selected = listed.result.choices.find((choice: { project: string }) => choice.project === alternate.name);
    const snapshot = await call('o8_task_options', { machineId: 'draft-machine', repoId: selected.repoId, projectId: selected.projectId });
    const prepared = await call('o8_prepare_task', { ...contract(snapshot.result.snapshotId), projectId: selected.projectId });
    expect(prepared.result).toMatchObject({ ok: true, state: 'held', dispatched: false });
    expect(listTaskDrafts(accountId)[0].contract.projectId).toBe(alternate.id);
    expect(intents()).toHaveLength(1);
    expect(launches).not.toHaveBeenCalled();
  });

  it('keeps permanent exact retry identity across expired snapshots, concurrent calls, and cold reads', async () => {
    const args = contract((await options()).snapshotId);
    const simultaneous = await Promise.all([call('o8_prepare_task', args), call('o8_prepare_task', args)]);
    expect(new Set(simultaneous.map((value) => value.result.taskId)).size).toBe(1);
    expect(intents()).toHaveLength(1);
    const file = join(taskDraftRoot(), 'snapshots', `${args.snapshotId}.json`);
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...snapshot, expiresAt: 1 }));
    const key = taskDraftKey(accountId, 'draft-client', 'draft-machine', args.idempotencyKey);
    const childDir = mkdtempSync(join(tmpdir(), 'o8-plugin-draft-child-'));
    dirs.push(childDir);
    const child = join(childDir, 'store-child.cjs');
    buildSync({ entryPoints: ['tests/fixtures/plugin-task-draft-store-child.fixture.ts'], outfile: child,
      platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent',
      alias: { 'server-only': join(process.cwd(), 'scripts/server-only-stub.js') } });
    const env = { ...process.env, CORTEX_IDE_DATA_DIR: getDataDir() };
    const cold = await execAsync(process.execPath, [child, 'read', key], { env, timeout: 5000 });
    expect(JSON.parse(cold.stdout).taskId).toBe(simultaneous[0].result.taskId);
    const stored = readTaskDraft(key)!;
    const independentKey = taskDraftKey(accountId, 'draft-client', 'draft-machine', 'two-process-store');
    const input = join(childDir, 'record.json');
    writeFileSync(input, JSON.stringify(stored));
    const independent = await Promise.all([
      execAsync(process.execPath, [child, 'bind', independentKey, input], { env, timeout: 5000 }),
      execAsync(process.execPath, [child, 'bind', independentKey, input], { env, timeout: 5000 }),
    ]);
    expect(independent.map((value) => JSON.parse(value.stdout).created).sort()).toEqual([false, true]);
    expect(new Set(independent.map((value) => JSON.parse(value.stdout).taskId)).size).toBe(1);
    // Simulate a process dying after atomic publication, before lock removal.
    mkdirSync(join(taskDraftRoot(), 'locks', key));
    expect((await call('o8_prepare_task', args)).result).toMatchObject({ taskId: simultaneous[0].result.taskId, replayed: true });
    expect((await call('o8_prepare_task', { ...args, objective: 'Changed task.' })).result.code).toBe('idempotency_key_conflict');
    expect(intents()).toHaveLength(2);
  });

  it('returns safe field guidance for rejected sealed metadata without persisting or launching', async () => {
    const args = contract((await options()).snapshotId);
    args.sealedTaskContract.requirements[0].productionPath = 'private-unrequested-file.txt';
    const refused = await call('o8_prepare_task', args);
    expect(refused.status).toBe(400);
    expect(refused.result).toMatchObject({ ok: false, code: 'contract_file_scope_mismatch' });
    expect(refused.result.message).toContain('requirements[].productionPath');
    expect(refused.result.message).toContain('smallestRoute[].path');
    expect(refused.result.message).toContain('new idempotency key');
    expect(JSON.stringify(refused.result)).not.toContain('private-unrequested-file');
    expect(intents()).toHaveLength(0);
    expect(launches).not.toHaveBeenCalled();
    const malformed = await call('o8_prepare_task', { ...args, sealedTaskContract: { version: 2 } });
    expect(malformed.result).toMatchObject({ ok: false, code: 'invalid_task_contract' });
    expect(malformed.result.message).toContain('sealedTaskContract');
    expect(intents()).toHaveLength(0);
  });

  it('recovers the same receipt after persistence succeeds but the final audit fails', async () => {
    const args = contract((await options()).snapshotId);
    const auditModule = await import('@/lib/mcp/plugin-audit');
    const append = auditModule.appendPluginAudit;
    vi.spyOn(auditModule, 'appendPluginAudit').mockImplementation((entry, dataDir) => {
      if (entry.phase === 'finished' && entry.tool === 'o8_prepare_task') throw new Error('Synthetic audit interruption');
      return append(entry, dataDir);
    });
    expect((await call('o8_prepare_task', args)).result.code).toBe('audit_outcome_unknown');
    const persisted = listTaskDrafts(accountId)[0];
    vi.restoreAllMocks();
    expect((await call('o8_prepare_task', args)).result).toMatchObject({ taskId: persisted.taskId, replayed: true });
    expect(intents()).toHaveLength(1);
  });

  it('refuses old read/follow-up grants, foreign accounts, missing epochs, expired licenses, and sign-out', async () => {
    const args = contract((await options()).snapshotId);
    expect((await call('o8_prepare_task', args, token(accountId, ['o8:read', 'o8:follow-up']))).status).toBe(403);
    expect((await call('o8_prepare_task', args, token('user_other_account'))).status).toBe(403);
    const epoch = readSignInEpoch()!;
    rmSync(join(getDataDir(), 'github-signin-epoch'));
    expect((await call('o8_prepare_task', args)).status).toBe(403);
    writeFileSync(join(getDataDir(), 'github-signin-epoch'), epoch);
    await account(accountId, -60);
    expect((await call('o8_prepare_task', args)).status).toBe(403);
    await account();
    const cache = JSON.parse(readFileSync(join(getDataDir(), 'entitlement.json'), 'utf8'));
    const pieces = cache.licenseKey.split('.');
    pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
    writeFileSync(join(getDataDir(), 'entitlement.json'), JSON.stringify({ ...cache, licenseKey: pieces.join('.') }));
    expect((await call('o8_prepare_task', args)).status).toBe(403);
    await account();
    writeFileSync(join(getDataDir(), 'auth-signed-out-at'), 'unreadable marker');
    expect((await call('o8_prepare_task', args)).status).toBe(403);
    expect(intents()).toHaveLength(0);
  });

  it('holds an account switch during admission and refuses old-session receipts after switching back', async () => {
    const args = contract((await options()).snapshotId);
    const capture = workspace.captureTaskDraftWorkspace;
    vi.spyOn(workspace, 'captureTaskDraftWorkspace').mockImplementationOnce(async (...params) => {
      const value = await capture(...params);
      await account('user_other_account');
      return value;
    });
    expect((await call('o8_prepare_task', args)).status).toBe(403);
    expect(intents()).toHaveLength(0);
    vi.restoreAllMocks();
    await account();
    const fresh = contract((await options()).snapshotId);
    expect((await call('o8_prepare_task', fresh)).result.ok).toBe(true);
    await account('user_other_account');
    expect((await call('o8_prepare_task', fresh, token('user_other_account'))).result.code).toBe('snapshot_unavailable');
    await account();
    expect((await call('o8_prepare_task', fresh)).status).toBe(403);
    expect(intents()).toHaveLength(1);
  });

  it('refuses expired snapshots, revision/rules changes, dirty workspaces and project mismatch', async () => {
    const args = contract((await options()).snapshotId);
    expect((await call('o8_prepare_task', { ...args, projectId: 'deleted-project' })).result.code).toBe('snapshot_unavailable');
    const file = join(taskDraftRoot(), 'snapshots', `${args.snapshotId}.json`);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), expiresAt: 1 }));
    expect((await call('o8_prepare_task', args)).result.code).toBe('snapshot_unavailable');
    writeFileSync(file, original);
    writeFileSync(join(repo, 'AGENTS.md'), 'Changed rules.\n');
    expect((await call('o8_prepare_task', args)).result.code).toBe('workspace_not_clean');
    git('add', 'AGENTS.md');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'changed rules');
    expect((await call('o8_prepare_task', args)).result.code).toBe('snapshot_stale');
    expect(intents()).toHaveLength(0);
  });

  it('refuses path escapes, symlinks, scope overrides, incompatible routing and unresolved effort', async () => {
    const args = contract((await options()).snapshotId);
    for (const changed of [
      { allowedFiles: ['../outside'] }, { command: 'echo unsafe' }, { workMode: 'edit' },
      { runtime: 'opencode' }, { model: 'claude-opus-5-5' }, { effort: 'adaptive' },
      { sealedTaskContract: { ...args.sealedTaskContract, smallestRoute: [{ path: 'other.md', requirements: ['R1'], reason: 'Different scope.' }] } },
    ]) expect((await call('o8_prepare_task', { ...args, ...changed })).result.ok).toBe(false);
    symlinkSync(join(repo, 'README.md'), join(repo, 'linked.md'));
    git('add', 'linked.md');
    git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'symlink');
    const linked = contract((await options()).snapshotId);
    linked.allowedFiles = ['linked.md'];
    linked.sealedTaskContract.requirements[0].productionPath = 'linked.md';
    linked.sealedTaskContract.smallestRoute[0].path = 'linked.md';
    expect((await call('o8_prepare_task', linked)).result.code).toBe('invalid_file_scope');
    expect(intents()).toHaveLength(0);
  });

  it('keeps inspection operator-only and leaves uncertain locks held', async () => {
    const req = new NextRequest('http://localhost/api/plugins/task-drafts', { headers: { authorization: `Bearer ${token()}` } });
    expect(panelGateMiddleware(req).status).toBe(403);
    expect((await inspectDrafts(req)).status).toBe(403);
    const key = taskDraftKey(accountId, 'draft-client', 'draft-machine', 'locked');
    const dir = join(taskDraftRoot(), 'locks', key);
    mkdirSync(dir, { recursive: true });
    await expect(withTaskDraftLock(key, async () => 'should not run')).rejects.toMatchObject({ code: 'draft_pending' });
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readTaskDraft(key)).toBeNull();
  });

  it('asks for project and objective before any workspace snapshot and keeps source guidance aligned', async () => {
    const before = readOrchestratorMissionState();
    const listed = await call('o8_task_options', { machineId: 'draft-machine' });
    expect(listed.result).toMatchObject({ selectionRequired: true, nextAction: 'ask_user',
      clarification: { required: ['project', 'objective'] }, executionEnabled: false });
    expect(listed.result.clarification.question).toMatch(/which.*project.*what/i);
    expect(listed.result).not.toHaveProperty('snapshotId');
    const snapshots = join(taskDraftRoot(), 'snapshots');
    expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toHaveLength(0);
    expect(intents()).toHaveLength(0);
    expect(readOrchestratorMissionState()).toEqual(before);
    expect(await runHeadlessSprintTick()).toMatchObject({ launched: 0 });

    const optionsTool = TASK_DRAFT_TOOLS.find((tool) => tool.name === 'o8_task_options')!;
    expect(optionsTool.title).toMatch(/^List/u);
    expect(optionsTool.description).toContain('project and objective');
    const skill = readFileSync(join(process.cwd(), 'plugins/o8/skills/connected-o8/SKILL.md'), 'utf8');
    expect(skill).toContain('before selecting IDs or preparing a task');
    expect(skill).toContain('Do not silently try another registration after a refused snapshot');
    expect(skill).toContain('user does not need to provide JSON');
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'plugins/o8/plugin.json'), 'utf8'));
    const metadata = Object.values(manifest.extensions as Record<string, {
      interface: { longDescription: string };
      review: { test_cases: { positive: Array<{ tools_triggered: string; expected_behavior: string }> } };
    }>)[0];
    expect(metadata.interface.longDescription).toContain('Ask for missing project and objective before selecting a workspace');
    const reviewCase = metadata.review.test_cases.positive.find((entry: { tools_triggered: string }) => entry.tools_triggered.includes('o8_prepare_task'));
    expect(reviewCase!.expected_behavior).toContain('Ask for missing project and objective before selecting IDs');

    // Model-independent source proof: only an explicit named choice proceeds.
    const choice = listed.result.choices.find((entry: { project: string }) => entry.project === projectName);
    const selected = await call('o8_task_options', { machineId: 'draft-machine', repoId: choice.repoId, projectId: choice.projectId });
    const args = contract(selected.result.snapshotId);
    const prepared = await call('o8_prepare_task', args);
    expect(prepared.result).toMatchObject({ ok: true, state: 'held', dispatched: false });
    expect(listTaskDrafts(accountId)).toHaveLength(1);
    expect(listTaskDrafts(accountId)[0].contract).toMatchObject({ projectId, allowedFiles: ['README.md'],
      runtime: args.runtime, model: args.model, effort: args.effort });
    expect(launches).not.toHaveBeenCalled();
  });

  it('reports a refused selected workspace and asks for direction without selecting another registration', async () => {
    const capture = vi.spyOn(workspace, 'captureTaskDraftWorkspace');
    writeFileSync(join(repo, 'README.md'), 'Uncommitted fixture change.\n');
    const refused = await call('o8_task_options', { machineId: 'draft-machine', repoId, projectId });
    expect(refused.status).toBe(409);
    expect(refused.result).toMatchObject({ ok: false, code: 'workspace_not_clean', nextAction: 'ask_user', selectionRequired: true });
    expect(refused.result.message).toContain('Do not try another registration');
    expect(capture).toHaveBeenCalledExactlyOnceWith(repoId, projectId);
    expect(intents()).toHaveLength(0);
    expect(launches).not.toHaveBeenCalled();
  });

  it('requires relay account binding for draft grants and caps local credentials to OAuth expiry', () => {
    expect(parsePluginRelayGrant({ clientId: 'draft-client', scopes: [PLUGIN_PREPARE_TASK_SCOPE], expiresAt: Date.now() + 60000 })).toBeNull();
    const expiry = Date.now() + 1000;
    const grant = parsePluginRelayGrant({ accountId, clientId: 'draft-client', scopes: [PLUGIN_PREPARE_TASK_SCOPE], expiresAt: expiry })!;
    const auth = pluginReplayAuthorization('draft-machine', grant, { rid: 'test', path: '/api/plugins/mcp', method: 'POST' });
    expect(resolvePluginToken(auth!.slice(7))).toMatchObject({ accountId, expiresAt: expiry });
    expect(() => mintPluginToken({ machineId: 'm', clientId: 'c', scopes: [PLUGIN_PREPARE_TASK_SCOPE] })).toThrow();
  });
});
