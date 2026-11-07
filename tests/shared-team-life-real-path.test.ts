import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the provider boundary; admission, owned receipts, Git inspection,
// HTTP error parsing and MCP dispatch use their real implementations.
const { launchRuntimeSurface } = vi.hoisted(() => ({ launchRuntimeSurface: vi.fn() }));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] } }) }));
vi.mock('@/lib/telemetry/uploader', () => ({ startTelemetryUploadLoop: () => {} }));
vi.mock('@/lib/telemetry/sentry-node', () => ({ initSentryNode: async () => {} }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({ repairFlippedOrchestratorTranscripts: () => {}, repairComposerPreamblePollution: () => {} }));
vi.mock('@/lib/panel/status-boot', () => ({ startStatusBootHooks: () => {} }));
vi.mock('@/lib/search/backfill', () => ({ runUnifiedSearchBackfills: async () => {} }));

import { POST } from '@/app/api/orchestrator/delegate/route';
import { closeDb, getSqlite } from '@/lib/db';
import { fastDelegationCapability } from '@/lib/orchestrator/fast-delegation-auth';
import { finishSharedCheckoutTeam, readSharedCheckoutTeam, settleSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { readSharedTeamsForThread } from '@/lib/orchestrator/shared-team-history';
import { createCortexDelegationHandlers } from '@/lib/mcp/cortex-delegation-handlers';
import { createSharedWorkerHeartbeat } from '@/lib/ws-server/shared-worker-heartbeat';
import { ensureNextServerInitialized } from '@/lib/startup/next';

let root: string;
let repoPath: string;
let data: string;
const owner = 'thoughts-old-owner';
const next = 'thoughts-new-owner';
const startup = globalThis as typeof globalThis & { __o8NextOptionalStartup?: Promise<void> };

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

function mutation(id: string) { return id.startsWith('o8-team-life-') ? id : `${basename(root)}-${id}`; }

function session(id: string, outcome: string, active = outcome === 'running') {
  id = mutation(id);
  const dir = join(data, 'owned-codex', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    surfaceId: `codex-owned:${id}`, launchMutationId: id, cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath),
    ...(active ? { activeRun: { pid: 123, outcome } } : {}), recentRuns: [{ outcome }],
  }));
}

function dispatch(id: string, thread = owner, path = 'src/task.ts') {
  return POST(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST',
    body: JSON.stringify({ prompt: 'Inspect assigned scope', repoPath, taskName: `worker-${id}`,
      runtime: 'codex', model: 'gpt-5.6-terra', readOnly: true, checkoutMode: 'shared', parentThreadId: thread,
      fastCapability: fastDelegationCapability(repoPath, thread), assignedPaths: [path], clientMutationId: mutation(id) }),
  }));
}

function team(thread = owner) { return readSharedCheckoutTeam({ repoPath, parentThreadId: thread }); }
function editTeam(edit: (receipt: NonNullable<ReturnType<typeof team>>) => void) {
  const receipt = team()!;
  edit(receipt);
  writeFileSync(join(data, 'shared-checkout-teams', `${receipt.id}.json`), JSON.stringify(receipt));
}
function mcp() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) =>
    POST(new NextRequest(url, { ...init, signal: init.signal ?? undefined }))));
  return createCortexDelegationHandlers({ apiFetch: vi.fn(), apiBase: 'http://localhost', repoPath,
    parentThreadId: owner, fastCapability: fastDelegationCapability(repoPath, owner), wsToken: 'fixture' });
}
const sharedFailure = 'Delegation failed: the shared checkout could not start this worker. Details are in the o8 server log.';
function archives() {
  const dir = join(data, 'shared-checkout-teams', 'archive');
  return existsSync(dir) ? readdirSync(dir).map(file => JSON.parse(readFileSync(join(dir, file), 'utf8'))) : [];
}
function snapshot() {
  return { head: git('rev-parse', 'HEAD'), index: readFileSync(join(repoPath, '.git', 'index')),
    status: git('status', '--porcelain'), readme: readFileSync(join(repoPath, 'README.md')) };
}

beforeEach(() => {
  closeDb();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-team-life-')));
  data = join(root, 'data'); repoPath = join(root, 'repo');
  mkdirSync(repoPath); mkdirSync(join(data, 'chat-history'), { recursive: true });
  vi.stubEnv('O8_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(data, 'owned-codex'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  for (const thread of [owner, next]) writeFileSync(join(data, 'chat-history', `${thread}.json`), JSON.stringify({
    repoPath, messages: [{ id: 'user', role: 'user', content: 'Inspect' },
      { id: 'assistant', role: 'assistant', content: '', receipt: { pickedMode: 'fast' } }],
  }));
  launchRuntimeSurface.mockReset().mockImplementation(async (input: Record<string, unknown>) => {
    session(String(input.clientMutationId), 'running');
    return { ok: true, surfaceId: `codex-owned:${input.clientMutationId}`, note: 'launched' };
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  delete startup.__o8NextOptionalStartup;
});

afterEach(() => {
  closeDb(); delete startup.__o8NextOptionalStartup;
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('shared team lifecycle through delegate and persisted owned receipts', () => {
  it('takes over two lost codex members and releases both claims', async () => {
    expect((await dispatch('failed')).status).toBe(200);
    expect((await dispatch('old', owner, 'src/second.ts')).status).toBe(200);
    for (const id of ['failed', 'old']) rmSync(join(data, 'owned-codex', mutation(id)), { recursive: true });
    editTeam(receipt => {
      receipt.members[0].state = 'failed';
      receipt.members[1].launchedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    });
    expect((await dispatch('takeover', next)).status).toBe(200);
    expect((await dispatch('second-claim', next, 'src/second.ts')).status).toBe(200);
    expect(archives()[0].members.map((member: { state: string }) => member.state)).toEqual(['lost', 'lost']);
    expect((await readSharedTeamsForThread(repoPath, owner))[0].members.map(member => member.state)).toEqual(['lost', 'lost']);
  });

  it('holds a missing running record inside the two-minute launch grace window', async () => {
    expect((await dispatch('young')).status).toBe(200);
    rmSync(join(data, 'owned-codex', mutation('young')), { recursive: true });
    editTeam(receipt => { receipt.members[0].launchedAt = new Date(Date.now() - 2 * 60_000).toISOString(); });
    const response = await dispatch('takeover', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/worker-young.*lost.*grace/);
    expect(team()?.members[0].state).toBe('running');
    expect((await dispatch('overlap')).status).toBe(422);
    expect(archives()).toEqual([]);
  });

  it.each(['failed', 'interrupted', 'completed', 'exited'])('lets the owner finish a lost member recorded as %s', async state => {
    expect((await dispatch('gone')).status).toBe(200);
    rmSync(join(data, 'owned-codex', mutation('gone')), { recursive: true });
    // Old receipts can carry runtime terminal names directly.
    editTeam(receipt => { Object.assign(receipt.members[0], { state }); });
    await settleSharedCheckoutTeam({ repoPath, parentThreadId: owner });
    expect(team()?.members[0].state).toBe('lost');
    const result = await finishSharedCheckoutTeam({ repoPath, parentThreadId: owner,
      reviewSummary: 'Clean checkout reviewed', verification: 'Fixture Git snapshot' });
    expect(result.team.members[0].state).toBe('lost');
    expect(team()).toBeNull();
    expect(archives()[0].members[0].state).toBe('lost');
  });

  it('releases a lost claim to the same owner without weakening dirty takeover holds', async () => {
    expect((await dispatch('gone')).status).toBe(200);
    rmSync(join(data, 'owned-codex', mutation('gone')), { recursive: true });
    editTeam(receipt => { receipt.members[0].state = 'failed'; });
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src/task.ts'), 'preserve lost worker edit\n');
    const response = await dispatch('foreign', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('uncommitted paths src/task.ts');
    expect(team()?.members[0].state).toBe('lost');
    expect((await dispatch('retry')).status).toBe(200);
  });

  it('uses an archived owned receipt instead of declaring its member lost', async () => {
    expect((await dispatch('archived')).status).toBe(200);
    session('archived', 'finished');
    mkdirSync(join(data, 'owned-codex-archive'));
    renameSync(join(data, 'owned-codex', mutation('archived')), join(data, 'owned-codex-archive', mutation('archived')));
    expect((await dispatch('takeover', next)).status).toBe(200);
    expect(archives()[0].members[0]).toMatchObject({ state: 'settled', settledOutcome: 'finished' });
  });

  it('masks filesystem failures through HTTP and MCP, and logs the real cause', async () => {
    const directory = join(data, 'shared-checkout-teams');
    mkdirSync(directory);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chmodSync(directory, 0o555);
    try {
      const response = await dispatch('unwritable');
      expect(response.status).toBe(422);
      const body = await response.text();
      expect(JSON.parse(body).error).toBe(sharedFailure);
      expect(body).not.toContain('/');
      const result = await mcp().handleLaunchAgent({ prompt: 'Inspect', taskName: 'unwritable-mcp', runtime: 'codex',
        model: 'gpt-5.6-terra', checkoutMode: 'shared', assignedPaths: ['src/task.ts'] });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(sharedFailure);
      expect(result.content[0]?.text).not.toContain('/');
      expect(warning.mock.calls.some(call => call.some(value => value instanceof Error && value.message.includes('EACCES')))).toBe(true);
    } finally { chmodSync(directory, 0o755); warning.mockRestore(); }
  });

  it('masks an untyped shared runtime exception and an untyped HTTP error in MCP', async () => {
    launchRuntimeSurface.mockRejectedValueOnce(new Error(`EACCES ${data}/private`));
    expect((await (await dispatch('unexpected')).json()).error).toBe(sharedFailure);
    const handlers = mcp();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: `EACCES ${data}/private` }), { status: 422 })));
    const result = await handlers.handleLaunchAgent({ prompt: 'Inspect', runtime: 'codex', checkoutMode: 'shared', assignedPaths: ['src/task.ts'] });
    expect(result.content[0]?.text).toBe(sharedFailure);
  });

  it('masks a raw failure persisted before the typed refusal boundary on HTTP replay', async () => {
    expect((await dispatch('old')).status).toBe(200);
    expect((await dispatch('overlap')).status).toBe(422);
    const db = getSqlite();
    const row = db.prepare('SELECT key FROM idempotency_keys WHERE key LIKE ?').get(`%${mutation('overlap')}%`) as { key: string };
    expect(row).toBeDefined();
    db.prepare('UPDATE idempotency_keys SET result_json = ? WHERE key = ?').run(JSON.stringify({
      status: 422, payload: { ok: false, error: `EACCES: permission denied, mkdir '${data}/private.lock'` },
    }), row.key);
    const response = await dispatch('overlap');
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: sharedFailure, replayed: true });
    expect(body).not.toContain('/');
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
  });

  it.each(['finished', 'failed', 'interrupted'])('archives a clean terminal %s team before a new thread launches', async outcome => {
    expect((await dispatch('old')).status).toBe(200);
    session('old', outcome);
    const before = snapshot();
    const response = await dispatch('new', next);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(team()?.parentThreadId).toBe(next);
    expect(archives()).toEqual([expect.objectContaining({ parentThreadId: owner, releasedBy: next,
      reason: 'settled-clean-takeover', members: [expect.objectContaining({
        state: outcome === 'finished' ? 'settled' : 'failed', settledOutcome: outcome,
      })] })]);
    expect((await readSharedTeamsForThread(repoPath, owner))).toHaveLength(1);
    expect(snapshot()).toEqual(before);
  });

  it('refuses takeover with the owning thread and live worker in the message', async () => {
    expect((await dispatch('old')).status).toBe(200);
    const before = snapshot();
    const response = await dispatch('new', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/thoughts-old-owner.*live worker worker-old/);
    expect(archives()).toEqual([]); expect(team()?.parentThreadId).toBe(owner);
    expect(snapshot()).toEqual(before);
  });

  it('refuses takeover and names uncommitted team paths, including released failed claims', async () => {
    expect((await dispatch('old')).status).toBe(200);
    session('old', 'failed');
    mkdirSync(join(repoPath, 'src')); writeFileSync(join(repoPath, 'src/task.ts'), 'team edit\n');
    git('add', 'src/task.ts');
    const before = snapshot();
    const response = await dispatch('new', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/thoughts-old-owner.*uncommitted paths src\/task.ts/);
    expect(archives()).toEqual([]); expect(team()?.parentThreadId).toBe(owner);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(repoPath, 'src/task.ts'), 'utf8')).toBe('team edit\n');
  });

  it('allows an unchanged dirty baseline but holds drift in that baseline', async () => {
    writeFileSync(join(repoPath, 'README.md'), 'pre-existing edit\n');
    expect((await dispatch('old')).status).toBe(200);
    session('old', 'finished');
    writeFileSync(join(repoPath, 'README.md'), 'changed during team\n');
    const response = await dispatch('new', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('README.md');
    writeFileSync(join(repoPath, 'README.md'), 'pre-existing edit\n');
    const before = snapshot();
    expect((await dispatch('retry', next)).status).toBe(200);
    expect(snapshot()).toEqual(before);
  });

  it('releases a failed launch claim for relaunch by its owner', async () => {
    launchRuntimeSurface.mockImplementationOnce(async (input: Record<string, unknown>) => {
      session(String(input.clientMutationId), 'failed');
      return { ok: false, surfaceId: `codex-owned:${input.clientMutationId}`, note: 'Worker exited at launch' };
    });
    expect((await dispatch('old')).status).toBe(422);
    const response = await dispatch('retry');
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(team()?.members[0]).toMatchObject({ state: 'failed', settledOutcome: 'failed', surfaceId: `codex-owned:${mutation('old')}` });
    expect(team()?.members[1]).toMatchObject({ state: 'running', paths: ['src/task.ts'] });
  });

  it('retains a failed launch claim while its owned process is still live', async () => {
    launchRuntimeSurface.mockImplementationOnce(async () => {
      session('old', 'running');
      return { ok: false, surfaceId: `codex-owned:${mutation('old')}`, note: 'Registration failed after spawn' };
    });
    expect((await dispatch('old')).status).toBe(422);
    const response = await dispatch('retry');
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('overlaps worker worker-old');
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
  });

  it('holds missing completion evidence and terminal outcomes that still have an active process', async () => {
    expect((await dispatch('old')).status).toBe(200);
    rmSync(join(data, 'owned-codex', mutation('old')), { recursive: true });
    expect((await dispatch('missing', next)).status).toBe(422);
    expect(archives()).toEqual([]);
    session('old', 'failed', true);
    const response = await dispatch('active', next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('live worker worker-old');
    expect(archives()).toEqual([]);
  });

  it('returns the actual overlap message through the MCP launch handler and delegate route', async () => {
    expect((await dispatch('old')).status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) =>
      POST(new NextRequest(url, { ...init, signal: init.signal ?? undefined }))));
    const handlers = createCortexDelegationHandlers({ apiFetch: vi.fn(), apiBase: 'http://localhost', repoPath,
      parentThreadId: owner, fastCapability: fastDelegationCapability(repoPath, owner), wsToken: 'fixture' });
    const result = await handlers.handleLaunchAgent({ prompt: 'Inspect', taskName: 'retry', runtime: 'codex',
      model: 'gpt-5.6-terra', checkoutMode: 'shared', assignedPaths: ['src/task.ts'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Shared checkout path overlaps worker worker-old');
    expect(result.content[0]?.text).not.toContain('\n');
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
  });

  it('settles receipt states at ws startup and on the existing worker heartbeat', async () => {
    expect((await dispatch('old')).status).toBe(200);
    session('old', 'finished');
    const heartbeat = createSharedWorkerHeartbeat({ readTranscript: async () => [], isBusy: () => true,
      registerAbort: () => () => {}, publish: () => {} });
    await vi.waitFor(() => expect(team()?.members[0]).toMatchObject({ state: 'settled', settledOutcome: 'finished' }));
    expect((await dispatch('second', owner, 'src/second.ts')).status).toBe(200);
    session('second', 'interrupted');
    heartbeat();
    await vi.waitFor(() => expect(team()?.members[1]).toMatchObject({ state: 'failed', settledOutcome: 'interrupted' }));
    expect(archives()).toEqual([]);
  });

  it('settles a crash receipt at Next startup without launching another worker', async () => {
    expect((await dispatch('old')).status).toBe(200);
    session('old', 'failed');
    await ensureNextServerInitialized();
    expect(team()?.members[0]).toMatchObject({ state: 'failed', settledOutcome: 'failed' });
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
    expect(archives()).toEqual([]);
  });
});
