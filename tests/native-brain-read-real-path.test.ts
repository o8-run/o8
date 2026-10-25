import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ compose: vi.fn() }));
vi.mock('@/lib/cortex/qa/classifier', () => ({ classifyQuestion: async () => ({ class: 'A', bm25Variants: ['release policy'] }) }));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', () => ({ embedQuestion: async () => null }));
vi.mock('@/lib/cortex/qa/composer', async original => ({ ...await original<typeof import('@/lib/cortex/qa/composer')>(),
  composeClassA: async (_question: string, scope: string, rows: import('@/lib/cortex/qa/types').TypedRow[], emit: (name: string, value: unknown) => void) => {
    fixture.compose(scope, rows);
    const facts = rows.filter(row => row.citation.kind === 'fact');
    emit('token', { text: facts.map(row => row.fields.content).join('\n') });
    for (const row of facts) emit('citation', { ...row.citation, title: 'Release policy' });
  },
}));
// The native OS policy is not available here. Exercise the actual launch
// preparation, supervisor, child CLI, middleware and answer route around it.
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', () => ({
  prepareWorkerSandbox: async (input: { binary: string; args: string[] }) => ({ ...input,
    profileText: 'fixture', profilePath: 'fixture' }),
}));
const root = mkdtempSync(path.join(tmpdir(), 'o8-native-brain-'));
const data = path.join(root, 'data');
const repo = path.join(root, 'repo');
const foreign = path.join(root, 'foreign');
const runtimeHome = path.join(root, 'runtime');
for (const directory of [data, repo, foreign, runtimeHome]) mkdirSync(directory);
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.O8_HYBRID_SCORER = '0';
const policy = 'Use a bounded review before release.';
writeFileSync(path.join(repo, 'policy.txt'), policy);
writeFileSync(path.join(data, 'ws-token'), crypto.randomUUID());
const { prepareSingleOrchestratorLaunch } = await import('@/lib/lane/single-orchestrator-policy');
const { panelGateMiddleware } = await import('@/middleware');
const answer = await import('@/app/api/cortex/ask/answer/route');
const { mintBrainReadWorkerToken } = await import('@/lib/auth/brain-read-worker-token');
const { resolveRequestPrincipalContext } = await import('@/lib/auth/principal');
const { verifyWorkerToken } = await import('@/lib/worker/auth');
const { closeDb, getSqlite } = await import('@/lib/db');
const projectA = 'brain-project-a';
const projectB = 'brain-project-b';
const ledger = { projects: [
  { id: projectA, name: 'Project A', repoPaths: [repo], createdAt: new Date().toISOString() },
  { id: projectB, name: 'Project B', repoPaths: [foreign], createdAt: new Date().toISOString() },
], activeProjectId: projectA };
writeFileSync(path.join(data, 'projects.json'), JSON.stringify(ledger));
for (const [id, name] of [[projectA, 'Project A'], [projectB, 'Project B']]) {
  getSqlite().prepare('INSERT INTO projects (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
    .run(id, name, id, id === projectB ? 'Foreign project metadata.' : 'Assigned project metadata.');
}
writeFileSync(path.join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [
  { id: 'repo-a', name: 'Repo A', localPath: repo, remoteUrl: null, defaultBranch: 'main', addedAt: new Date().toISOString() },
  { id: 'repo-b', name: 'Repo B', localPath: foreign, remoteUrl: null, defaultBranch: 'main', addedAt: new Date().toISOString() },
] }));
for (const [project, repository] of [[projectA, 'repo-a'], [projectB, 'repo-b']]) {
  getSqlite().prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(project, repository);
}
for (const [id, content, scope] of [['policy', policy, repo], ['foreign-policy', 'Foreign release policy.', foreign]]) {
  getSqlite().prepare(`INSERT INTO facts
    (id, kind, content, source_kind, source_id, source_excerpt, repo_path, confidence, fingerprint, extracted_by, source_authority)
    VALUES (?, 'decision', ?, 'test', ?, ?, ?, 1, ?, 'test', 1)`).run(id, content, id, content, scope, id);
}
let requests = 0;
let presentedWorker = false;
let expectedWorker: string | undefined;
const server = createServer(async (incoming, outgoing) => {
  try {
    requests++;
    let body = ''; for await (const chunk of incoming) body += chunk;
    const headers = new Headers(incoming.headers as Record<string, string>);
    headers.set('host', 'localhost');
    const request = new NextRequest(`http://localhost${incoming.url}`, {
      method: incoming.method, headers, ...(body ? { body } : {}),
    });
    presentedWorker = Boolean(expectedWorker && headers.get('authorization') === `Bearer ${expectedWorker}`);
    const gate = panelGateMiddleware(request);
    const result = gate.status === 200 ? await answer.POST(request) : gate;
    outgoing.writeHead(result.status, { 'content-type': 'application/json' }); outgoing.end(await result.text());
  } catch { outgoing.writeHead(500); outgoing.end('{}'); }
});

async function read(token: string | null, body: Record<string, unknown> = {}, endpoint = '/api/cortex/ask/answer', method = 'POST') {
  return fetch(`${base}${endpoint}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ question: 'Release policy?', ...body }) } : {}),
  });
}

it('keeps invalid and expired credentials refused without another authority or retry', async () => {
  const valid = mintBrainReadWorkerToken(repo, projectA);
  const malformed = `${valid.slice(0, 5)}${valid[5] === 'A' ? 'B' : 'A'}${valid.slice(6)}`;
  const expired = mintBrainReadWorkerToken(repo, projectA, Date.now() - 2 * 60 * 60_000);
  const before = fixture.compose.mock.calls.length;
  const beforeRequests = requests;
  for (const token of [null, crypto.randomUUID(), malformed, expired, 'single-mode-no-operator-authority']) {
    expect((await read(token)).status).toBe(401);
    expect(resolveRequestPrincipalContext(new Request(base, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })).role).toBe('anonymous');
  }
  expect(requests - beforeRequests).toBe(5);
  expect(fixture.compose.mock.calls.length).toBe(before);
});

it('keeps an expired CLI read explicit and never falls back to the inherited operator credential', async () => {
  const expired = mintBrainReadWorkerToken(repo, projectA, Date.now() - 2 * 60 * 60_000);
  const before = requests;
  const result = await promisify(execFile)(process.execPath, [cli, 'ask', 'Release policy?'], {
    cwd: repo, env: { ...inherited, O8_WORKER_TOKEN: expired }, timeout: 20_000,
  }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }));
  expect(result.code).toBe(3);
  expect(requests - before).toBe(1);
  expect(result.stdout).toBe('');
  const failure = JSON.parse(result.stderr);
  expect(failure.error.code).toBe('unauthorized');
  expect(failure.error.hint).toContain('new authorized turn');
  expect(failure.error.hint).not.toMatch(/O8_API_TOKEN|ws-token/);
});

it('refuses foreign projects, packets and symlink escapes before retrieval', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA);
  const link = path.join(repo, 'outside');
  symlinkSync(foreign, link, 'dir');
  const before = fixture.compose.mock.calls.length;
  for (const body of [{ repoPath: foreign }, { projectId: 'other-project' },
    { packetId: 'other-packet' }, { repoPath: link }]) {
    const result = await read(token, body);
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe('worker_brain_scope_mismatch');
  }
  expect(fixture.compose.mock.calls.length).toBe(before);
  const nested = path.join(repo, 'src'); mkdirSync(nested);
  expect((await read(token, { repoPath: nested })).status).toBe(200);
  expect(fixture.compose.mock.calls.at(-1)?.[0]).toBe(repo);
});

it('keeps the Brain capability out of all other API and worker protocol routes', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA);
  const before = fixture.compose.mock.calls.length;
  for (const [endpoint, method] of [
    ['/api/cortex/ask/answer', 'GET'], ['/api/cortex/ask', 'POST'],
    ['/api/operator/mcp', 'POST'], ['/api/runtime/launch', 'POST'],
    ['/api/worker/register', 'POST'], ['/api/panel/status', 'GET'], ['/api/mobile/enroll', 'POST'],
  ]) expect((await read(token, {}, endpoint, method)).status).toBe(403);
  expect(verifyWorkerToken(`Bearer ${token}`)).toEqual({ ok: false, status: 403 });
  expect(resolveRequestPrincipalContext(new Request(base, { headers: { authorization: `Bearer ${token}` } })))
    .toMatchObject({ role: 'worker', readOnly: true, brainRepoPath: repo, packetId: null });
  expect(fixture.compose.mock.calls.length).toBe(before);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
const base = `http://127.0.0.1:${address.port}`;
const inherited = { ...process.env, O8_API_PORT: String(address.port), O8_API_TOKEN: readFileSync(path.join(data, 'ws-token'), 'utf8') };
const cli = path.join(root, 'cli.mjs');
await (await import('esbuild')).build({ entryPoints: [path.join(process.cwd(), 'cli/src/index.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: cli,
  banner: { js: 'import { createRequire as __fixture_require } from "node:module"; const require = __fixture_require(import.meta.url); globalThis.require = require;' },
  define: { __O8_CLI_VERSION__: JSON.stringify('fixture') },
});
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); rmSync(root, { recursive: true, force: true });
});

it('reads project Brain through the native launch environment and the real CLI once', async () => {
  const command = [process.execPath, cli, 'ask', 'What is the release policy?'].map(shellQuote).join(' ');
  const prepared = await prepareSingleOrchestratorLaunch({ repoPath: repo, codexHome: runtimeHome,
    binary: '/bin/sh', args: ['-c', command], env: inherited });
  expectedWorker = prepared.env.O8_WORKER_TOKEN;
  const before = requests;
  try {
    const result = await promisify(execFile)(prepared.binary, prepared.args, {
      cwd: repo, env: prepared.env, timeout: 20_000,
    }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }));
    expect(result.code, result.stderr).toBe(0);
    expect(presentedWorker).toBe(true);
    expect(requests - before).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.answer).toBe(policy);
    expect(payload.citations).toEqual([expect.objectContaining({ rowId: 'policy', title: 'Release policy' })]);
    expect(readFileSync(path.join(repo, 'policy.txt'), 'utf8')).toBe(payload.answer);
    expect(fixture.compose.mock.calls.at(-1)?.[0]).toBe(repo);
    expect(result.stdout + result.stderr).not.toContain(expectedWorker);
    expect(prepared.env.O8_API_TOKEN).not.toBe(inherited.O8_API_TOKEN);
  } finally { prepared.cleanup(); }
});

it('refuses ambient project fallback and preserves its signed project after an active-project switch', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA);
  ledger.activeProjectId = projectB;
  writeFileSync(path.join(data, 'projects.json'), JSON.stringify(ledger));
  const own = await read(token, { question: 'Release policy after switching projects?' });
  expect(own.status).toBe(200);
  const result = await own.json();
  expect(result.answer).toBe(policy);
  expect(result.citations.map((citation: { rowId: string }) => citation.rowId)).toEqual(['policy']);
  expect(getSqlite().prepare('SELECT content FROM facts WHERE id = ?').get('policy')).toEqual({ content: result.answer });
  const unlinked = path.join(root, 'unlinked'); mkdirSync(unlinked);
  const unlinkedToken = mintBrainReadWorkerToken(unlinked, null);
  expect((await read(unlinkedToken)).status).toBe(403);
});

it('refuses a rebound granted root even when the request omits its repository', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA);
  const retained = path.join(root, 'retained-repo');
  renameSync(repo, retained); symlinkSync(foreign, repo, 'dir');
  try { expect((await read(token, { question: 'Rebound root release policy?' })).status).toBe(401); }
  finally { unlinkSync(repo); renameSync(retained, repo); }
});

it('refuses a repository shared by persisted projects before any project metadata is composed', async () => {
  const sqlite = getSqlite();
  sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectB, 'repo-a');
  ledger.activeProjectId = projectA;
  writeFileSync(path.join(data, 'projects.json'), JSON.stringify(ledger));
  const token = mintBrainReadWorkerToken(repo, projectA);
  const before = fixture.compose.mock.calls.length;
  expect.soft((await read(token, { question: 'Release policy in this project?' })).status).toBe(403);
  expect(fixture.compose.mock.calls.length).toBe(before);
});
