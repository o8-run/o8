import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ compose: vi.fn(), vector: null as number[] | null,
  classify: vi.fn(async (): Promise<{ class: 'A' | 'B'; bm25Variants: string[] }> => ({ class: 'A', bm25Variants: ['release policy'] })) }));
vi.mock('@/lib/cortex/qa/classifier', () => ({ classifyQuestion: fixture.classify }));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', async original => ({
  ...await original<typeof import('@/lib/cortex/qa/llm/gemini-embed')>(), embedQuestion: async () => fixture.vector,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/cortex/qa/composer', async original => {
  const compose = async (_question: string, scope: string, rows: import('@/lib/cortex/qa/types').TypedRow[], emit: (name: string, value: unknown) => void) => {
    fixture.compose(scope, rows);
    const sources = rows.filter(row => ['fact', 'pr', 'doc', 'directive'].includes(row.citation.kind));
    emit('token', { text: sources.map(row => row.fields.content ?? row.fields.title).join('\n') });
    for (const row of sources) emit('citation', { ...row.citation, title: row.fields.title ?? 'Release policy' });
  };
  return { ...await original<typeof import('@/lib/cortex/qa/composer')>(), composeClassA: compose, composeClassB: compose };
});
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
async function cliRead(token: string, cwd: string, question: string) {
  return promisify(execFile)(process.execPath, [cli, 'ask', question], {
    cwd, env: { ...inherited, O8_WORKER_TOKEN: token }, timeout: 20_000,
  }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }));
}
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

it('keeps eighteen scope denials identical and anonymous reads unauthorized', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA); const before = fixture.compose.mock.calls.length;
  const bodies = [
    ...[foreign, ...Array.from({ length: 5 }, (_, index) => path.join(root, `missing-${index}`))].map(repoPath => ({ repoPath })),
    ...[projectB, ...Array.from({ length: 5 }, (_, index) => `missing-project-${index}`)].map(projectId => ({ projectId })),
    ...Array.from({ length: 6 }, (_, index) => ({ packetId: `missing-packet-${index}` })),
  ];
  let expected: unknown;
  for (const body of bodies) {
    const response = await read(token, body); expect(response.status).toBe(403);
    const result = await response.json(); expected ??= result; expect(result).toEqual(expected);
  }
  expect((await read(null)).status).toBe(401); expect(fixture.compose.mock.calls.length).toBe(before);
});

it('keeps operator and worker cache entries separate while retaining exact cache hits', async () => {
  const question = 'Release policy cache authority control?';
  const operator = inherited.O8_API_TOKEN; const worker = mintBrainReadWorkerToken(repo, projectA);
  const foreignAnswer = await (await read(operator, { question, repoPath: foreign })).json();
  expect(foreignAnswer.answer).toBe('Foreign release policy.');
  const own = await (await read(worker, { question })).json(); expect(own.answer).toBe(policy);
  const operatorCached = await (await read(operator, { question, repoPath: foreign })).json();
  expect(operatorCached).toMatchObject({ answer: foreignAnswer.answer, cacheHit: 'exact' });
  const workerCached = await (await read(worker, { question })).json();
  expect(workerCached).toMatchObject({ answer: policy, cacheHit: 'exact' });
});

it('uses live membership after panel removal through HTTP and the built CLI, including warm answers', async () => {
  const sqlite = getSqlite(); const original = readFileSync(path.join(data, 'projects.json'), 'utf8');
  const question = 'Release policy membership snapshot?';
  const token = mintBrainReadWorkerToken(repo, projectA);
  const removed = mintBrainReadWorkerToken(foreign, projectA);
  sqlite.prepare('DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?').run(projectB, 'repo-b');
  sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectA, 'repo-b');
  const stale = structuredClone(ledger); stale.projects[0].repoPaths = [repo, foreign]; stale.activeProjectId = projectA;
  writeFileSync(path.join(data, 'projects.json'), JSON.stringify(stale));
  try {
    fixture.vector = [1, 0, 0];
    expect((await (await read(token, { question })).json()).answer).toContain('Foreign release policy.');
    expect(JSON.parse((await cliRead(token, repo, question)).stdout).answer).toContain('Foreign release policy.');
    const request = new NextRequest('http://localhost/api/panel/projects/' + projectA, { method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${inherited.O8_API_TOKEN}` },
      body: JSON.stringify({ repoPaths: [repo] }),
    });
    expect(panelGateMiddleware(request).status).toBe(200);
    const panel = await import('@/app/api/panel/projects/[id]/route');
    expect((await panel.PATCH(request, { params: Promise.resolve({ id: projectA }) })).status).toBe(200);
    expect(sqlite.prepare('SELECT 1 FROM project_repos WHERE project_id = ? AND repo_id = ?').get(projectA, 'repo-b')).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(data, 'projects.json'), 'utf8')).projects[0].repoPaths).toContain(foreign);
    sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectB, 'repo-b');
    const missing = mintBrainReadWorkerToken(foreign, 'missing-project');
    const absent = await read(missing, { question }); const absentBody = await absent.json();
    const refusal = await read(removed, { question });
    expect([403, 404]).toContain(refusal.status); expect(refusal.status).toBe(absent.status);
    expect(await refusal.json()).toEqual(absentBody);
    const refusedCli = await cliRead(removed, foreign, question);
    expect(refusedCli.code).toBe(3); expect(refusedCli.stdout).toBe('');
    const missingCli = await cliRead(missing, foreign, question);
    expect(JSON.parse(refusedCli.stderr).error).toEqual(JSON.parse(missingCli.stderr).error);
    const http = await read(token, { question }); expect(http.status).toBe(200);
    const answer = await http.json();
    expect.soft(answer.answer).toBe(policy);
    expect.soft(answer.citations.map((citation: { rowId: string }) => citation.rowId)).toEqual(['policy']);
    const built = await cliRead(token, repo, question); expect(built.code, built.stderr).toBe(0);
    expect.soft(JSON.parse(built.stdout).answer).toBe(policy);
    expect.soft(built.stdout).not.toContain('foreign-policy');
    const semantic = await (await read(token, { question: 'How should release policy membership be applied?' })).json();
    expect(semantic).toMatchObject({ answer: policy, cacheHit: 'semantic' });
  } finally {
    fixture.vector = null;
    sqlite.prepare('DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?').run(projectA, 'repo-b');
    sqlite.prepare('INSERT OR IGNORE INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectB, 'repo-b');
    writeFileSync(path.join(data, 'projects.json'), original);
  }
}, 60000);

it('keeps full repository identity for same-basename PRs through HTTP and the built CLI', async () => {
  const sqlite = getSqlite(); const priorProjects = readFileSync(path.join(data, 'projects.json'), 'utf8');
  const priorRepos = readFileSync(path.join(data, 'repos.json'), 'utf8');
  const projectLedger = JSON.parse(priorProjects); const registry = JSON.parse(priorRepos);
  const ownRepo = path.join(root, 'scope-a', 'checkout'); const otherRepo = path.join(root, 'scope-b', 'checkout');
  const ownTitle = 'Release policy assigned repository'; const otherTitle = 'Release policy foreign repository';
  for (const [index, localPath, title] of [[1, ownRepo, ownTitle], [2, otherRepo, otherTitle]] as const) {
    mkdirSync(localPath, { recursive: true });
    const id = `same-name-${index}`; const fullName = `fixture-scope-${index}/checkout`;
    projectLedger.projects.push({ id, name: id, repoPaths: [localPath], createdAt: new Date().toISOString() });
    registry.repos.push({ id, name: 'checkout', localPath, remoteUrl: `https://github.com/${fullName}.git`, defaultBranch: 'main', addedAt: new Date().toISOString() });
    sqlite.prepare('INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, id, id);
    sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(id, id);
    sqlite.prepare(`INSERT INTO github_pull_requests (pull_request_id, repo_full_name, number, title, body, state, url, head_ref_name)
      VALUES (?, ?, 1, ?, 'Release policy', 'open', ?, 'shared-fixture-branch')`).run(100 + index, fullName, title, `https://github.com/${fullName}/pull/1`);
    sqlite.prepare(`INSERT INTO docs (id, repo_path, repo_name, rel_path, kind, title, body, size_bytes, last_modified, last_synced)
      VALUES (?, ?, 'checkout', 'policy.md', 'markdown', ?, 'Release policy', 14, '2026-01-01', '2026-01-01')`)
      .run(`same-doc-${index}`, localPath, title + ' document');
  }
  mkdirSync(path.join(data, 'directives'), { recursive: true });
  writeFileSync(path.join(data, 'directives', 'foreign-repo-directive.md'), '---\nid: foreign-repo-directive\ntitle: Release policy foreign repository directive\nscope: checkout\nrepoName: legacy-name\n---\nRelease policy.\n');
  sqlite.prepare('INSERT INTO directives_fts (directive_id, title, body) VALUES (?, ?, ?)')
    .run('foreign-repo-directive', 'Release policy foreign repository directive', 'Release policy.');
  sqlite.prepare(`INSERT INTO session_outcomes (id, project_id, repo_path, branch, runtime, outcome, summary, started_at, completed_at)
    VALUES ('assigned-outcome', 'same-name-1', ?, 'shared-fixture-branch', 'codex', 'succeeded', 'Release policy outcome', '2026-01-01', '2026-01-01')`).run(ownRepo);
  writeFileSync(path.join(data, 'projects.json'), JSON.stringify(projectLedger));
  writeFileSync(path.join(data, 'repos.json'), JSON.stringify(registry));
  try {
    const token = mintBrainReadWorkerToken(ownRepo, 'same-name-1'); const question = 'Release policy repository identity?';
    const response = await read(token, { question }); expect(response.status).toBe(200);
    const result = await response.json();
    expect.soft(result.answer).toContain(ownTitle); expect.soft(result.answer).not.toContain(otherTitle);
    expect.soft(result.citations.filter((citation: { kind: string }) => citation.kind === 'pr').map((citation: { rowId: string }) => citation.rowId)).toEqual(['101']);
    expect(JSON.stringify(fixture.compose.mock.calls.at(-1)?.[1])).not.toContain(otherTitle);
    expect(result.citations.filter((citation: { kind: string }) => citation.kind === 'doc').map((citation: { rowId: string }) => citation.rowId)).toEqual(['same-doc-1']);
    expect(result.citations.map((citation: { rowId: string }) => citation.rowId)).not.toContain('foreign-repo-directive');
    const built = await cliRead(token, ownRepo, question); expect(built.code, built.stderr).toBe(0);
    expect.soft(built.stdout).toContain(ownTitle); expect.soft(built.stdout).not.toContain(otherTitle);
    expect.soft(JSON.parse(built.stdout).citations.map((citation: { rowId: string }) => citation.rowId)).not.toContain('102');
  } finally {
    sqlite.prepare('DELETE FROM github_pull_requests WHERE pull_request_id IN (101, 102)').run();
    sqlite.prepare("DELETE FROM session_outcomes WHERE id = 'assigned-outcome'").run();
    sqlite.prepare("DELETE FROM docs WHERE id IN ('same-doc-1', 'same-doc-2')").run();
    sqlite.prepare("DELETE FROM directives_fts WHERE directive_id = 'foreign-repo-directive'").run();
    rmSync(path.join(data, 'directives', 'foreign-repo-directive.md'), { force: true });
    sqlite.prepare("DELETE FROM project_repos WHERE project_id IN ('same-name-1', 'same-name-2')").run();
    sqlite.prepare("DELETE FROM projects WHERE id IN ('same-name-1', 'same-name-2')").run();
    writeFileSync(path.join(data, 'projects.json'), priorProjects); writeFileSync(path.join(data, 'repos.json'), priorRepos);
  }
}, 60000);

it('does not coalesce a built CLI request with an in-flight answer from another membership snapshot', async () => {
  const sqlite = getSqlite(); const token = mintBrainReadWorkerToken(repo, projectA);
  const question = 'Release policy concurrent cache membership?';
  let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.classify.mockImplementationOnce(async () => { entered = true; await gate; return { class: 'B', bm25Variants: ['release policy'] }; });
  const first = read(token, { question });
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    sqlite.prepare('DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?').run(projectB, 'repo-b');
    sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectA, 'repo-b');
    const second = await cliRead(token, repo, question); expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).answer).toContain('Foreign release policy.');
    release(); const oldAnswer = await (await first).json(); expect(oldAnswer.answer).toBe(policy);
  } finally {
    release(); await first;
    sqlite.prepare('DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?').run(projectA, 'repo-b');
    sqlite.prepare('INSERT OR IGNORE INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectB, 'repo-b');
  }
}, 30000);

it('refuses SQL membership read failure before using a warm answer or the JSON sidecar', async () => {
  const token = mintBrainReadWorkerToken(repo, projectA); const question = 'Release policy membership failure?';
  expect((await read(token, { question })).status).toBe(200);
  const before = fixture.compose.mock.calls.length;
  const projects = await import('@/lib/projects/store');
  const spy = vi.spyOn(projects, 'listProjects').mockImplementationOnce(() => { throw new Error('Fixture membership store unavailable'); });
  try {
    const response = await read(token, { question }); expect(response.status).toBe(403);
    const missing = await read(mintBrainReadWorkerToken(repo, 'missing-project'), { question });
    expect(await response.json()).toEqual(await missing.json());
    expect(fixture.compose.mock.calls.length).toBe(before);
  } finally { spy.mockRestore(); }
});

it.each(['http', 'cli'] as const)('keeps in-flight %s retrieval inside its admitted SQL membership snapshot', async entry => {
  const sqlite = getSqlite(); const token = mintBrainReadWorkerToken(repo, projectA);
  let release!: () => void; let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.classify.mockImplementationOnce(async () => { entered = true; await gate; return { class: 'B', bm25Variants: ['release policy'] }; });
  const question = `Release policy in-flight snapshot ${entry}?`;
  const pending = entry === 'http' ? read(token, { question, bypassCache: true }) : cliRead(token, repo, question);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    sqlite.prepare('INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, 1)').run(projectB, 'repo-a');
    release();
    const result = await pending;
    if (entry === 'http') expect((result as Response).status).toBe(200);
    else expect((result as { code: number }).code).toBe(0);
    expect(JSON.stringify(fixture.compose.mock.calls.at(-1)?.[1])).not.toContain('Foreign project metadata.');
    expect(JSON.stringify(fixture.compose.mock.calls.at(-1)?.[1])).not.toContain('foreign-policy');
    const denied = await read(token, { question }); expect(denied.status).toBe(403);
  } finally {
    release(); await pending;
    sqlite.prepare('DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?').run(projectB, 'repo-a');
  }
}, 30000);

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
