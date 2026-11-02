import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', auth: vi.fn(), resolveGate: null as Promise<void> | null, resolveEntered: null as (() => void) | null }));
const principal = vi.hoisted(() => ({ role: 'operator' }));
vi.mock('@/lib/auth/principal', async (original) => ({
  ...(await original<typeof import('@/lib/auth/principal')>()),
  resolveRequestPrincipalContext: () => ({ role: principal.role }),
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: state.auth }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => path.join(state.root, 'data'), migrateDataDirOnce: () => {} }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async (localPath: string) => { state.resolveEntered?.(); if (state.resolveGate) await state.resolveGate; return localPath === path.join(state.root, 'repo') ? { localPath } : null; } }));
import { GET, POST } from './route';

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/customize/actions', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
async function post(body: unknown) { return POST(request(body)); }
function source(script = '#!/bin/sh\nprintf "hello action\\n"\n') {
  const directory = path.join(state.root, 'source');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'run.sh'), script);
  chmodSync(path.join(directory, 'run.sh'), 0o700);
  const manifest = {
    format: 'o8-actions-v1', id: 'sample', name: 'Sample', version: '1.0.0', description: 'Local test',
    supportedPlatforms: [process.platform], workspace: 'none',
    files: [{ path: 'run.sh', sha256: createHash('sha256').update(script).digest('hex') }],
    actions: [{ id: 'run', description: 'Run sample', entry: 'run.sh', args: [], timeoutMs: 5000 }],
  };
  writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

describe('action plugin API and subprocess', () => {
  beforeEach(() => {
    state.root = realpathSync(mkdtempSync('/tmp/o8-action-route-'));
    state.resolveGate = null;
    state.resolveEntered = null;
    mkdirSync(path.join(state.root, 'data'));
    state.auth.mockReset().mockReturnValue(null);
  });
  afterEach(() => rmSync(state.root, { recursive: true, force: true }));

  it('requires auth before reading a source path', async () => {
    state.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await post({ action: 'review', directory: '/missing' })).status).toBe(401);
  });

  it('reviews, links exact bytes, invokes the stored snapshot, writes a durable receipt, disables and removes', async () => {
    const { directory } = source();
    const review = await post({ action: 'review', directory });
    expect(review.status, JSON.stringify(await review.clone().json())).toBe(200);
    const reviewed = (await review.json()).review;
    const revision = reviewed.revision;
    expect(reviewed.files[0]).toMatchObject({ path: 'run.sh', content: '#!/bin/sh\nprintf "hello action\\n"\n', sha256: reviewed.manifest.files[0].sha256 });
    const withSelectedRepo = (await (await post({ action: 'review', directory, repo: '/unregistered-selected-repo' })).json()).review;
    expect(withSelectedRepo.revision).toBe(revision);
    expect(withSelectedRepo.execution.cwd).toContain('/customizations/actions/sample');
    expect((await post({ action: 'link', directory, expectedRevision: revision, repo: '/unregistered-selected-repo' })).status).toBe(400);
    const linked = await post({ action: 'link', directory, expectedRevision: revision });
    expect(linked.status).toBe(200);
    writeFileSync(path.join(directory, 'run.sh'), '#!/bin/sh\nprintf "changed\\n"\n');
    const invoked = await post({ action: 'invoke', id: 'sample', actionId: 'run', revision });
    expect(invoked.status).toBe(200);
    expect((await invoked.json()).receipt).toMatchObject({ actor: 'local-operator', actorKind: 'authorization-class', actorIdentity: null, revision, status: 'succeeded', stdout: 'hello action\n' });
    const inventory = await GET(request());
    const body = await inventory.json();
    expect(body.receipts[0]).toMatchObject({ plugin_id: 'sample', action_id: 'run', status: 'succeeded', revision, actorKind: 'authorization-class', actorIdentity: null });
    const filtered = await GET(new NextRequest('http://localhost/api/customize/actions?plugin=sample'));
    expect((await filtered.json()).receipts).toHaveLength(1);
    const installedFile = path.join(state.root, 'data', 'customizations', 'actions', 'sample', 'run.sh');
    expect(readFileSync(installedFile, 'utf8')).toContain('hello action');
    writeFileSync(installedFile, '#!/bin/sh\nprintf "tampered\\n"\n');
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).status).toBe(409);
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision, repo: '/unregistered-selected-repo' })).status).toBe(400);
    expect((await post({ action: 'disable', id: 'sample', revision })).status).toBe(200);
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).status).toBe(409);
    expect((await post({ action: 'remove', id: 'sample', revision })).status).toBe(200);
    expect((await (await GET(request())).json()).installed).toEqual([]);
    expect((await (await GET(request())).json()).receipts).toHaveLength(1);
  });

  it('rejects traversal, linked files, digest mismatch, and stale review', async () => {
    const { directory, manifest } = source();
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    writeFileSync(path.join(directory, 'run.sh'), '#!/bin/sh\nexit 1\n');
    expect((await post({ action: 'link', directory, expectedRevision: revision })).status).toBe(409);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, files: [{ path: '../run.sh', sha256: manifest.files[0].sha256 }] }));
    expect((await post({ action: 'review', directory })).status).toBe(400);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(manifest));
    rmSync(path.join(directory, 'run.sh'));
    symlinkSync(path.join(state.root, 'data'), path.join(directory, 'run.sh'));
    expect((await post({ action: 'review', directory })).status).toBe(400);
  });

  it('refuses executable files that cannot be inspected as text', async () => {
    const { directory, manifest } = source();
    const binary = Buffer.from([0x23, 0x21, 0x00, 0xff]);
    writeFileSync(path.join(directory, 'run.sh'), binary);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, files: [{ path: 'run.sh', sha256: createHash('sha256').update(binary).digest('hex') }] }));
    const response = await post({ action: 'review', directory });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('unreviewable_file');
  });

  it('rejects Windows action manifests until process-tree cleanup is supported', async () => {
    const { directory, manifest } = source();
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, supportedPlatforms: ['win32'] }));
    expect((await post({ action: 'review', directory })).status).toBe(400);
  });

  it('rejects NUL arguments before a run can be recorded', async () => {
    const { directory, manifest } = source();
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, actions: [{ ...manifest.actions[0], args: ['bad\0argument'] }] }));
    expect((await post({ action: 'review', directory })).status).toBe(400);
    expect((await (await GET(request())).json()).receipts).toEqual([]);
  });

  it('runs both shipped example actions through review, link, invoke, and persisted receipts', async () => {
    const repo = path.join(state.root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q']);
    writeFileSync(path.join(repo, 'package.json'), '{"name":"example-project","version":"1.0.0"}\n');
    writeFileSync(path.join(repo, 'AGENTS.md'), '# Project instructions\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial fixture']);
    const examples = path.join(process.cwd(), 'examples', 'action-plugins');
    for (const [id, actionId, expected] of [
      ['project-setup-check', 'check', 'Project setup check'],
      ['verification-receipt', 'collect', 'Verification receipt'],
    ]) {
      const directory = path.join(examples, id);
      const reviewed = await post({ action: 'review', directory, repo });
      expect(reviewed.status).toBe(200);
      const revision = (await reviewed.json()).review.revision as string;
      expect((await post({ action: 'link', directory, repo, expectedRevision: revision })).status).toBe(200);
      const invoked = await post({ action: 'invoke', id, actionId, revision, repo });
      expect(invoked.status).toBe(200);
      expect((await invoked.json()).receipt).toMatchObject({ status: 'succeeded', revision, actor: 'local-operator' });
      expect((await (await GET(request())).json()).receipts[0].stdout).toContain(expected);
    }
    expect((await (await GET(request())).json()).receipts).toHaveLength(2);
  });

  it('runs the built operator CLI through the action API and reads its persisted receipt after route restart', async () => {
    const { directory } = source();
    const reviewed = await post({ action: 'review', directory });
    const revision = (await reviewed.json()).review.revision as string;
    expect((await post({ action: 'link', directory, expectedRevision: revision })).status).toBe(200);
    execFileSync(process.execPath, [path.join(process.cwd(), 'cli', 'esbuild.config.mjs')], { cwd: process.cwd() });
    const cliEntry = path.join(process.cwd(), 'cli', 'dist', 'o8.mjs');
    let routes = { GET, POST };
    state.auth.mockImplementation((incoming: NextRequest) => incoming.headers.get('authorization') === 'Bearer plugin-cli-test-token'
      ? null : Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const nextRequest = new NextRequest(`http://localhost${incoming.url ?? '/api/customize/actions'}`, {
          method: incoming.method,
          headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' },
          ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = incoming.method === 'POST' ? await routes.POST(nextRequest) : await routes.GET(nextRequest);
        outgoing.writeHead(response.status, { 'content-type': 'application/json' });
        outgoing.end(await response.text());
      } catch (error) {
        outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.message : 'Route failed');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an isolated TCP port.');
    const runCli = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, ...args], {
        cwd: state.root,
        env: { ...process.env, HOME: state.root, O8_DATA_DIR: path.join(state.root, 'data'), O8_API_PORT: String(address.port), O8_API_TOKEN: 'plugin-cli-test-token', O8_WORKER_TOKEN: '', O8_SPECTATOR_TOKEN: '', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    try {
      const actions = await runCli(['plugin', 'action', 'list']);
      expect(actions.code, actions.stderr).toBe(0);
      expect(JSON.parse(actions.stdout)).toMatchObject({ schema: 'o8/cli/plugin.action.list/v1', actions: [{ pluginId: 'sample', revision }] });
      const invoked = await runCli(['plugin', 'action', 'invoke', 'sample', 'run', '--revision', revision]);
      expect(invoked.code, invoked.stderr).toBe(0);
      const cliReceipt = JSON.parse(invoked.stdout).receipt;
      expect(cliReceipt).toMatchObject({ status: 'succeeded', stdout: 'hello action\n', actorKind: 'authorization-class', actorIdentity: null });
      vi.resetModules();
      routes = await import('./route');
      const logs = await runCli(['plugin', 'log', 'list', '--plugin', 'sample']);
      expect(logs.code, logs.stderr).toBe(0);
      expect(JSON.parse(logs.stdout).receipts[0]).toMatchObject({ id: cliReceipt.id, actorKind: 'authorization-class', actorIdentity: null });
      const worker = await runCli(['plugin', 'action', 'invoke', 'sample', 'run', '--revision', revision], { O8_WORKER_TOKEN: 'worker-test-token' });
      expect(worker.code).toBe(3);
      const authorizedRead = new NextRequest('http://localhost/api/customize/actions', { headers: { authorization: 'Bearer plugin-cli-test-token' } });
      expect((await (await routes.GET(authorizedRead)).json()).receipts).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('filters plugin receipts before the global history cap', async () => {
    const { directory } = source();
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision as string;
    expect((await post({ action: 'link', directory, expectedRevision: revision })).status).toBe(200);
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).status).toBe(200);
    const database = new Database(path.join(state.root, 'data', 'customizations', 'actions', 'receipts.sqlite'));
    try {
      const insert = database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < 101; index += 1) {
        insert.run(`other-${index}`, 'other', 'run', 'local-operator', revision, 'succeeded', `9999-01-01T00:00:${String(index).padStart(3, '0')}Z`);
      }
    } finally { database.close(); }
    expect((await (await GET(request())).json()).receipts).toHaveLength(100);
    const filtered = await GET(new NextRequest('http://localhost/api/customize/actions?plugin=sample'));
    expect((await filtered.json()).receipts).toMatchObject([{ plugin_id: 'sample', action_id: 'run' }]);
  });

  it('enforces timeout and records the failure', async () => {
    const { directory, manifest } = source('#!/bin/sh\nsleep 2\n');
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, actions: [{ ...manifest.actions[0], timeoutMs: 100 }] }));
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    expect((await post({ action: 'link', directory, expectedRevision: revision })).status).toBe(200);
    const receipt = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).json()).receipt;
    expect(receipt.status).toBe('timeout');
    expect((await (await GET(request())).json()).receipts[0].status).toBe('timeout');
  });

  it('refuses overlapping runs and records only one subprocess attempt', async () => {
    const { directory } = source('#!/bin/sh\nsleep 0.4\nprintf "finished\\n"\n');
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision });
    const first = post({ action: 'invoke', id: 'sample', actionId: 'run', revision });
    let running = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      running = (await (await GET(request())).json()).receipts.some((receipt: { status: string }) => receipt.status === 'running');
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(true);
    expect((await post({ action: 'disable', id: 'sample', revision })).status).toBe(409);
    expect((await post({ action: 'remove', id: 'sample', revision })).status).toBe(409);
    const calls = await Promise.all([first, post({ action: 'invoke', id: 'sample', actionId: 'run', revision })]);
    expect(calls.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await (await GET(request())).json()).receipts).toHaveLength(1);
  });

  it('checks supported platform and redacts credential text before persisting output', async () => {
    const { directory, manifest } = source('#!/bin/sh\nprintf "Bearer secretvalue\\n"\n');
    const unsupported = process.platform === 'darwin' ? 'linux' : 'darwin';
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, supportedPlatforms: [unsupported] }));
    const firstRevision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: firstRevision });
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision: firstRevision })).status).toBe(409);
    await post({ action: 'remove', id: 'sample', revision: firstRevision });
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(manifest));
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision });
    const receipt = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).json()).receipt;
    expect(receipt.stdout).toBe('Bearer [redacted]\n');
    expect((await (await GET(request())).json()).receipts[0].stdout).toBe('Bearer [redacted]\n');
  });

  it('rejects a linked receipt database without touching its target', async () => {
    const outside = path.join(state.root, 'outside');
    writeFileSync(outside, 'preserve');
    const actions = path.join(state.root, 'data', 'customizations', 'actions');
    mkdirSync(actions, { recursive: true });
    symlinkSync(outside, path.join(actions, 'receipts.sqlite'));
    expect((await GET(request())).status).toBe(400);
    expect(readFileSync(outside, 'utf8')).toBe('preserve');
  });

  it('runs only in the selected registered repository when the manifest requests project scope', async () => {
    const { directory, manifest } = source('#!/bin/sh\npwd\n');
    const repo = path.join(state.root, 'repo');
    mkdirSync(repo);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, workspace: 'registered-project' }));
    expect((await post({ action: 'review', directory })).status).toBe(400);
    const reviewed = (await (await post({ action: 'review', directory, repo })).json()).review;
    const revision = reviewed.revision;
    expect(reviewed.execution).toEqual({ cwd: repo, environmentKeys: ['PATH', 'NODE_ENV'], principal: 'local-user' });
    expect((await post({ action: 'link', directory, expectedRevision: revision, repo })).status).toBe(200);
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).status).toBe(400);
    expect((await post({ action: 'invoke', id: 'sample', actionId: 'run', revision, repo: path.join(state.root, 'unregistered') })).status).toBe(403);
    const receipt = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision, repo })).json()).receipt;
    expect(receipt.status).toBe('succeeded');
    expect(receipt.stdout).toBe(`${repo}\n`);
    const installed = (await (await GET(request())).json()).installed[0];
    expect(installed).toMatchObject({ sourceDirectory: directory, workspaceRoot: repo, revision });
  });

  it('rechecks the installation after repository resolution and refuses a disabled version', async () => {
    const { directory, manifest } = source('#!/bin/sh\nprintf "should not run\\n"\n');
    const repo = path.join(state.root, 'repo');
    mkdirSync(repo);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, workspace: 'registered-project' }));
    const revision = (await (await post({ action: 'review', directory, repo })).json()).review.revision;
    await post({ action: 'link', directory, repo, expectedRevision: revision });
    let release!: () => void;
    state.resolveGate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { state.resolveEntered = resolve; });
    const pending = post({ action: 'invoke', id: 'sample', actionId: 'run', revision, repo });
    await entered;
    expect((await post({ action: 'disable', id: 'sample', revision })).status).toBe(200);
    release();
    expect((await pending).status).toBe(409);
    expect((await (await GET(request())).json()).receipts).toEqual([]);
  });

  it('does not spawn replacement bytes after remove and relink during repository resolution', async () => {
    const { directory, manifest } = source('#!/bin/sh\nprintf "old\\n"\n');
    const repo = path.join(state.root, 'repo');
    mkdirSync(repo);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, workspace: 'registered-project' }));
    const revision = (await (await post({ action: 'review', directory, repo })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision, repo });
    let release!: () => void;
    state.resolveGate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { state.resolveEntered = resolve; });
    const pending = post({ action: 'invoke', id: 'sample', actionId: 'run', revision, repo });
    await entered;
    state.resolveGate = null;
    expect((await post({ action: 'remove', id: 'sample', revision })).status).toBe(200);
    const replacement = '#!/bin/sh\nprintf "replacement\\n"\n';
    writeFileSync(path.join(directory, 'run.sh'), replacement);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, workspace: 'registered-project', files: [{ path: 'run.sh', sha256: createHash('sha256').update(replacement).digest('hex') }] }));
    const newRevision = (await (await post({ action: 'review', directory, repo })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: newRevision, repo });
    release();
    expect((await pending).status).toBe(409);
    expect((await (await GET(request())).json()).receipts).toEqual([]);
  });

  it('bounds cancellation and output, and uses an enum status for spawn failure', async () => {
    const { directory, manifest } = source('#!/bin/sh\nsleep 5\n');
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision });
    const controller = new AbortController();
    const pending = POST(new NextRequest('http://localhost/api/customize/actions', { method: 'POST', body: JSON.stringify({ action: 'invoke', id: 'sample', actionId: 'run', revision }), signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const cancelled = (await (await pending).json()).receipt;
    expect(cancelled.status).toBe('cancelled');
    await post({ action: 'remove', id: 'sample', revision });

    const noisy = '#!/bin/sh\nyes X | head -c 80000\n';
    writeFileSync(path.join(directory, 'run.sh'), noisy);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, files: [{ path: 'run.sh', sha256: createHash('sha256').update(noisy).digest('hex') }] }));
    const noisyRevision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: noisyRevision });
    const capped = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision: noisyRevision })).json()).receipt;
    expect(capped.status).toBe('output_limit');
    expect(Buffer.byteLength(capped.stdout + capped.stderr)).toBeLessThanOrEqual(64 * 1024);
    await post({ action: 'remove', id: 'sample', revision: noisyRevision });

    const broken = '#!/missing/interpreter\n';
    writeFileSync(path.join(directory, 'run.sh'), broken);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, files: [{ path: 'run.sh', sha256: createHash('sha256').update(broken).digest('hex') }] }));
    const brokenRevision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: brokenRevision });
    const failed = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision: brokenRevision })).json()).receipt;
    expect(failed.status).toBe('spawn_error');
    expect(failed.error).toBeTruthy();
    expect(failed.status).not.toContain('/');
  });

  it.skipIf(process.platform === 'win32')('kills background descendants when their parent exits', async () => {
    const { directory } = source('#!/bin/sh\nsleep 20 >/dev/null 2>&1 &\nprintf "%s\\n" "$!"\n');
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision });
    const receipt = (await (await post({ action: 'invoke', id: 'sample', actionId: 'run', revision })).json()).receipt;
    expect(receipt.status).toBe('succeeded');
    const pid = Number(receipt.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    let processState = '';
    try { processState = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); } catch { /* Process already reaped. */ }
    expect(processState === '' || processState.startsWith('Z')).toBe(true);
  });

  it('reads receipts after a module restart and enforces real handler auth', async () => {
    const { directory } = source();
    const revision = (await (await post({ action: 'review', directory })).json()).review.revision;
    await post({ action: 'link', directory, expectedRevision: revision });
    await post({ action: 'invoke', id: 'sample', actionId: 'run', revision });
    vi.resetModules();
    const restarted = await import('./route');
    expect((await (await restarted.GET(request())).json()).receipts[0].status).toBe('succeeded');
    const database = new Database(path.join(state.root, 'data', 'customizations', 'actions', 'receipts.sqlite'));
    database.prepare("UPDATE receipts SET status = 'running', started_at = '2000-01-01T00:00:00.000Z', finished_at = NULL").run();
    database.close();
    expect((await restarted.POST(request({ action: 'disable', id: 'sample', revision }))).status).toBe(200);
    expect((await (await restarted.GET(request())).json()).receipts[0].status).toBe('interrupted');
    await restarted.POST(request({ action: 'remove', id: 'sample', revision }));
    vi.doUnmock('@/lib/panel/auth');
    vi.doUnmock('@/lib/repos/registry');
    vi.resetModules();
    const previous = process.env.WS_TOKEN;
    process.env.WS_TOKEN = 'test-operator-token-for-route-auth';
    try {
      const actualAuthRoute = await import('./route');
      const remote = new NextRequest('http://example.com/api/customize/actions', { headers: { host: 'example.com', 'x-o8-client-addr': '203.0.113.1' } });
      expect((await actualAuthRoute.GET(remote)).status).toBe(401);
      const repo = path.join(state.root, 'repo');
      mkdirSync(repo);
      writeFileSync(path.join(state.root, 'data', 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'test-repo', name: 'Test repo', localPath: repo, remoteUrl: null, defaultBranch: 'main', isGitRepo: false, addedAt: new Date().toISOString(), lastOpenedAt: null, storagePressureParkingDisabled: false, setup: {} }] }));
      const manifest = JSON.parse(readFileSync(path.join(directory, 'o8-actions.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, workspace: 'registered-project' }));
      const operatorPost = (body: unknown) => actualAuthRoute.POST(new NextRequest('http://example.com/api/customize/actions', {
        method: 'POST', body: JSON.stringify(body), headers: { host: 'example.com', 'x-o8-client-addr': '203.0.113.1', authorization: 'Bearer test-operator-token-for-route-auth' },
      }));
      const reviewed = await operatorPost({ action: 'review', directory, repo });
      expect(reviewed.status).toBe(200);
      const realRevision = (await reviewed.json()).review.revision;
      expect((await operatorPost({ action: 'link', directory, repo, expectedRevision: realRevision })).status).toBe(200);
      const invoked = (await (await operatorPost({ action: 'invoke', id: 'sample', actionId: 'run', revision: realRevision, repo })).json()).receipt;
      expect(invoked).toMatchObject({ status: 'succeeded', revision: realRevision, stdout: 'hello action\n' });
      const operatorGet = new NextRequest('http://example.com/api/customize/actions', { headers: { host: 'example.com', 'x-o8-client-addr': '203.0.113.1', authorization: 'Bearer test-operator-token-for-route-auth' } });
      expect((await (await actualAuthRoute.GET(operatorGet)).json()).receipts[0].status).toBe('succeeded');
    } finally { if (previous === undefined) delete process.env.WS_TOKEN; else process.env.WS_TOKEN = previous; }
  });
});

it('refuses action requests from a worker', async () => {
  principal.role = 'worker';
  try {
    expect((await post({ action: 'invoke', id: 'a', actionId: 'b', revision: 'c' })).status).toBe(403);
  } finally {
    principal.role = 'operator';
  }
});
