import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DistillBatchInput } from '@/lib/cortex/indexer/doc-distill';
import type { TypedRow } from '@/lib/cortex/qa/types';
const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o8-knowledge-')));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  process.env.CORTEX_IDE_DATA_DIR = data; process.env.O8_DATA_DIR = data; process.env.O8_HYBRID_SCORER = '0';
  return { root, data, distill: vi.fn(), compose: vi.fn(), sendLead: vi.fn(async () => {}) };
});
vi.mock('@/lib/lane/orchestrator-send-entry', () => ({ sendOrchestratorBackendTurn: fixture.sendLead }));
vi.mock('@/lib/cortex/indexer/doc-distill', () => ({ distillDocChunkBatch: fixture.distill }));
vi.mock('@/lib/cortex/qa/classifier', () => ({ classifyQuestion: async () => ({ class: 'A', bm25Variants: ['Apricot'] }) }));
vi.mock('@/lib/cortex/qa/composer', async original => ({ ...await original<typeof import('@/lib/cortex/qa/composer')>(),
  composeClassA: async (_question: string, _repo: unknown, rows: TypedRow[], emit: (name: string, value: unknown) => void) => {
    await fixture.compose(rows);
    emit('token', { text: rows.map(row => row.fields.content).join('\n') });
    rows.forEach(row => emit('citation', { ...row.citation, rowId: `${row.citation.kind}-${row.citation.rowId}` }));
  },
}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: vi.fn() }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: vi.fn() }));
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
const sourcesApi = await import('@/app/api/cortex/sources/route');
const answerApi = await import('@/app/api/cortex/ask/answer/route');
const { getOperatorDefaults, getOperatorDefaultsSync, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { indexKnowledgeSources, stopKnowledgeSourceWatcher } = await import('@/lib/cortex/knowledge');
const { retrieveFacts } = await import('@/lib/cortex/qa/retrievers/facts');
const { getSqlite, closeDb } = await import('@/lib/db');
const token = getOrCreateWsToken();
const text = (name: string) => `${name} is the orchard policy. ${'This is a sufficiently detailed local note for the documentation chunker. '.repeat(4)}`;
function request(body?: unknown, auth = true, endpoint = '/api/cortex/sources') {
  return new NextRequest(`http://localhost${endpoint}`, { method: body ? 'POST' : 'GET', headers: auth ? { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function add(folder: string, extra = {}) {
  const response = await sourcesApi.POST(request({ action: 'add', path: folder, ...extra }));
  expect(response.status, await response.clone().text()).toBe(200);
  await indexKnowledgeSources();
  return (await response.json()).sources.at(-1) as { id: string; path: string };
}
const facts = () => getSqlite().prepare("SELECT content, source_excerpt FROM facts WHERE source_kind = 'knowledge'").all();
let folder: string;
beforeEach(async () => {
  stopKnowledgeSourceWatcher();
  for (const source of (await getOperatorDefaults()).values.knowledgeSources) await sourcesApi.POST(request({ action: 'remove', id: source.id }));
  stopKnowledgeSourceWatcher();
  folder = path.join(fixture.root, crypto.randomUUID()); mkdirSync(folder);
  fixture.distill.mockReset().mockImplementation(async ({ chunks }: DistillBatchInput) => ({ factsByChunkId: new Map(chunks.map(chunk => [chunk.id,
    [{ kind: 'decision', content: chunk.text.includes('Bronze') ? 'Bronze is the orchard policy.' : 'Apricot is the orchard policy.', source_excerpt: chunk.text.slice(0, 160), confidence: 0.9 }]])), estTokens: 1 }));
  fixture.compose.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const req = new NextRequest(url, init ? { ...init, signal: init.signal ?? undefined } : undefined);
    if (req.nextUrl.pathname === '/api/cortex/sources') return init?.method === 'POST' ? sourcesApi.POST(req) : sourcesApi.GET(req);
    if (req.nextUrl.pathname === '/api/cortex/ask/answer') return answerApi.POST(req);
    throw new Error('Unexpected outbound request');
  }));
});
afterEach(() => { stopKnowledgeSourceWatcher(); vi.unstubAllGlobals(); });
afterAll(async () => { stopKnowledgeSourceWatcher(); await indexKnowledgeSources(); closeDb(); rmSync(fixture.root, { recursive: true, force: true }); });
it('exposes read-only knowledge-source management through the real operator MCP catalog', async () => {
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'full');
  expect((response?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toContain('cortex_knowledge_sources');
});
it('refuses unauthenticated source reads and mutations', async () => {
  expect((await sourcesApi.GET(request(undefined, false))).status).toBe(403);
  expect((await sourcesApi.POST(request({ action: 'add', path: folder }, false))).status).toBe(403);
  expect((await getOperatorDefaults()).values.knowledgeSources).toEqual([]);
});
it('registers the exact literal notes folder without trimming significant whitespace', async () => {
  const literal = `${folder} `; mkdirSync(literal);
  writeFileSync(path.join(literal, 'plan.md'), text('Apricot'));
  writeFileSync(path.join(folder, 'plan.md'), text('Bronze'));
  const registered = await add(literal);
  expect(registered.path).toBe(literal);
  expect(getOperatorDefaultsSync().values.knowledgeSources[0].path).toBe(literal);
  expect(JSON.stringify(facts())).toContain('Apricot');
  expect(JSON.stringify(facts())).not.toContain('Bronze');
  expect(readdirSync(literal)).toEqual(['plan.md']);
});
it.each(['repository', 'source'] as const)('refuses a case alias of an existing %s during source registration', async owner => {
  const registry = await import('@/lib/repos/registry');
  const registered = owner === 'repository' ? await registry.addRepo(folder) : null;
  if (owner === 'source') await add(folder);
  const alias = path.join(path.dirname(folder), path.basename(folder).toUpperCase());
  const insensitive = existsSync(alias) && statSync(alias).ino === statSync(folder).ino;
  if (!insensitive) mkdirSync(alias);
  try {
    const response = await sourcesApi.POST(request({ action: 'add', path: alias }));
    expect(response.status, await response.clone().text()).toBe(insensitive ? 400 : 200);
    expect((await getOperatorDefaults()).values.knowledgeSources).toHaveLength(owner === 'source' ? (insensitive ? 1 : 2) : (insensitive ? 0 : 1));
  } finally { if (registered) await registry.removeRepo(registered.id); }
});
it('indexes safe markdown through MCP, persists defaults, and answers cortex_ask with note citations without writing the source', async () => {
  const body = `---\ntitle: Orchard handbook\n---\n# Orchard\n## Policy\n${text('Apricot')} [[Related decision]]\n## Credentials\n${text('Secret')}\napi_key: sk-proj-${'x'.repeat(40)}\n## api_key: sk-proj-${'y'.repeat(40)}\n${text('Heading secret')}\n`;
  writeFileSync(path.join(folder, 'plan.md'), body);
  const response = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cortex_knowledge_sources', arguments: { action: 'add', path: folder } } }, 'full');
  expect((response?.result as { isError?: boolean }).isError).not.toBe(true);
  await indexKnowledgeSources();
  expect(fixture.distill).toHaveBeenCalled();
  expect(JSON.stringify(fixture.distill.mock.calls)).not.toContain('sk-proj-');
  expect(JSON.stringify(facts())).toContain('Apricot'); expect(JSON.stringify(facts())).not.toContain('Secret');
  expect(getOperatorDefaultsSync().values.knowledgeSources[0].path).toBe(folder);
  const settings = readFileSync(path.join(fixture.data, 'settings.toml'), 'utf8'); expect(settings).toContain('knowledge_sources');
  const answer = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cortex_ask', arguments: { question: 'Apricot', bypassCache: true } } }, 'full');
  const payload = JSON.parse((answer?.result as { content: Array<{ text: string }> }).content[0].text);
  expect(payload.answer).toContain('Apricot');
  expect(payload.citations).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePath: path.join(folder, 'plan.md'), title: 'Orchard handbook' })]));
  const rows = await retrieveFacts({ question: 'Apricot' });
  expect(rows.rows[0].fields.wikiLinks).toContain('Related decision');
  expect(readdirSync(folder)).toEqual(['plan.md']); expect(readFileSync(path.join(folder, 'plan.md'), 'utf8')).toBe(body);
});
it('skips hidden/excluded notes and linked files/directories that escape the configured source', async () => {
  const outside = path.join(fixture.root, 'outside.md'); writeFileSync(outside, text('Outside'));
  writeFileSync(path.join(folder, 'good.md'), text('Apricot')); writeFileSync(path.join(folder, '.hidden.md'), text('Hidden'));
  mkdirSync(path.join(folder, 'archive')); writeFileSync(path.join(folder, 'archive', 'old.md'), text('Archive'));
  symlinkSync(outside, path.join(folder, 'linked.md')); symlinkSync(path.dirname(outside), path.join(folder, 'linked-directory'), 'dir');
  await add(folder, { exclude: ['archive/**'] });
  const sent = fixture.distill.mock.calls.flatMap(([input]) => (input as DistillBatchInput).chunks.map(c => c.relPath));
  expect(sent).toEqual(['good.md']);
});
it('distills only changed chunks, removes deleted facts and keeps citation metadata', async () => {
  const file = path.join(folder, 'plan.md'); writeFileSync(file, `# Notes\n## First\n${text('Apricot')}\n## Second\n${text('Bronze')}`);
  const source = await add(folder); fixture.distill.mockClear();
  writeFileSync(file, `# Notes\n## First\n${text('Apricot')}\n## Second\n${text('Bronze')} The policy changed.`);
  await indexKnowledgeSources();
  expect(fixture.distill.mock.calls).toHaveLength(1); expect(fixture.distill.mock.calls[0][0].chunks).toHaveLength(1);
  const response = await sourcesApi.POST(request({ action: 'remove', id: source.id })); expect(response.status).toBe(200);
  expect(facts()).toEqual([]); expect((await retrieveFacts({ question: 'Apricot' })).rows).toEqual([]);
  expect(readFileSync(file, 'utf8')).toContain('The policy changed');
});
it('does not resurrect facts when a source is removed during pending distillation', async () => {
  writeFileSync(path.join(folder, 'plan.md'), text('Apricot'));
  let finish!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pending!: DistillBatchInput;
  fixture.distill.mockImplementationOnce(async (input: DistillBatchInput) => { pending = input; entered(); return new Promise(resolve => { finish = resolve; }); });
  const response = await sourcesApi.POST(request({ action: 'add', path: folder })); const source = (await response.json()).sources[0];
  await started;
  expect((await sourcesApi.POST(request({ action: 'remove', id: source.id }))).status).toBe(200);
  finish({ factsByChunkId: new Map(pending.chunks.map(chunk => [chunk.id, [{ kind: 'decision', content: 'Apricot must not return.', source_excerpt: chunk.text.slice(0, 160), confidence: 0.9 }]])), estTokens: 1 }); await indexKnowledgeSources(); expect(facts()).toEqual([]);
});
it('blocks registration and direct worker/worktree dispatch into a knowledge folder', async () => {
  writeFileSync(path.join(folder, 'plan.md'), text('Apricot')); await add(folder);
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  await expect(new WorktreeManager(folder).create({ agentType: 'codex', taskName: 'test' })).rejects.toThrow('read-only');
  const { addRepo, listRepos } = await import('@/lib/repos/registry');
  expect(await listRepos()).toEqual([]); await expect(addRepo(folder)).rejects.toThrow('read-only');
  await expect(addRepo(path.dirname(folder))).rejects.toThrow('read-only');
  const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
  await expect(launchRuntimeSurface({ runtime: 'codex', prompt: 'change', cwd: folder })).rejects.toThrow('read-only');
  await expect(launchRuntimeSurface({ runtime: 'codex', prompt: 'change', cwd: path.dirname(folder) })).rejects.toThrow('read-only');
  const { dispatch } = await import('@/lib/lane/commands');
  expect(await dispatch({ verb: 'open_lane', repoPath: folder, branch: 'work', runtime: 'codex', label: 'test' })).toMatchObject({ ok: false, note: expect.stringContaining('read-only') });
  expect(readdirSync(folder)).toEqual(['plan.md']);
});

it('observes filesystem edits and deletions through the running source watcher', async () => {
  const file = path.join(folder, 'plan.md'); writeFileSync(file, text('Apricot'));
  await add(folder); fixture.distill.mockClear();
  writeFileSync(file, text('Bronze'));
  await vi.waitFor(() => expect(JSON.stringify(facts())).toContain('Bronze'), { timeout: 8_000, interval: 50 });
  expect(fixture.distill).toHaveBeenCalledTimes(1);
  unlinkSync(file);
  await vi.waitFor(() => expect(facts()).toEqual([]), { timeout: 8_000, interval: 50 });
}, 20_000);
it('rejects linked roots and invalid patterns before persisting sources or starting inference', async () => {
  const linked = path.join(fixture.root, crypto.randomUUID()); symlinkSync(folder, linked, 'dir');
  expect((await sourcesApi.POST(request({ action: 'add', path: linked }))).status).toBe(400);
  expect((await sourcesApi.POST(request({ action: 'add', path: folder, include: ['../*.md'] }))).status).toBe(400);
  expect(getOperatorDefaultsSync().values.knowledgeSources).toEqual([]); expect(fixture.distill).not.toHaveBeenCalled();
});
it('runs the built CLI source commands against the real authenticated API', async () => {
  const { build } = await import('esbuild'); const { spawn } = await import('node:child_process'); const { createServer } = await import('node:http');
  const bundle = path.join(fixture.root, 'cli.mjs');
  await build({ entryPoints: ['cli/src/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle,
    banner: { js: 'import { createRequire as __o8_knowledge_require } from "node:module"; const require = __o8_knowledge_require(import.meta.url); globalThis.require = require;' }, define: { __O8_CLI_VERSION__: '"test"' } });
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      const request = new NextRequest(`http://localhost${req.url}`, { method: req.method, headers: { authorization: String(req.headers.authorization ?? ''), 'Content-Type': 'application/json' }, ...(body ? { body } : {}) });
      const response = req.method === 'POST' ? await sourcesApi.POST(request) : await sourcesApi.GET(request);
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, 'brain', 'sources', ...args], { env: { ...process.env, O8_WORKER_TOKEN: '', O8_API_PORT: String(address.port), O8_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`CLI exit ${code}: ${stderr}`)));
  });
  try {
    const added = JSON.parse(await run(['add', folder, '--name', 'CLI notes', '--exclude', 'archive/**']));
    expect(added.sources[0]).toMatchObject({ name: 'CLI notes', path: folder, exclude: ['archive/**'] });
    expect(JSON.parse(await run(['list'])).sources).toHaveLength(1);
    expect(JSON.parse(await run(['remove', added.sources[0].id])).sources).toEqual([]);
    expect(getOperatorDefaultsSync().values.knowledgeSources).toEqual([]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 20_000);

it('reconciles direct defaults and full TOML removal immediately, including cached answers', async () => {
  writeFileSync(path.join(folder, 'plan.md'), text('Apricot')); await add(folder);
  const { askCortex } = await import('@/lib/cortex/qa/ask');
  expect((await askCortex('Apricot', undefined)).answer).toContain('Apricot');
  const { applyOperatorDefaultsToml, getOperatorDefaultsTomlState } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ knowledgeSources: [] });
  expect(facts()).toEqual([]); expect((await askCortex('Apricot', undefined)).answer).not.toContain('Apricot');
  await add(folder); expect(facts().length).toBeGreaterThan(0);
  const state = await getOperatorDefaultsTomlState();
  await applyOperatorDefaultsToml('[brain]\n', state.revision);
  expect(facts()).toEqual([]); expect((await askCortex('Apricot', undefined)).answer).not.toContain('Apricot');
});
it('protects source additions and implicit TOML removal at the shared defaults API', async () => {
  writeFileSync(path.join(folder, 'plan.md'), text('Apricot')); await add(folder);
  const defaultsApi = await import('@/app/api/panel/operator-defaults/route');
  expect((await defaultsApi.POST(request({ knowledgeSources: [] }, false))).status).toBe(403);
  expect((await defaultsApi.POST(request({ settingsToml: '[brain]\n', settingsTomlRevision: 'fixture' }, false))).status).toBe(403);
  expect(getOperatorDefaultsSync().values.knowledgeSources).toHaveLength(1); expect(facts().length).toBeGreaterThan(0);
});
it('re-distills heading-only edits and removes a previously indexed chunk if its heading becomes sensitive', async () => {
  const file = path.join(folder, 'plan.md'); writeFileSync(file, `## Initial\n${text('Apricot')}`);
  await add(folder); fixture.distill.mockClear();
  writeFileSync(file, `## Changed meaning\n${text('Apricot')}`); await indexKnowledgeSources();
  expect(fixture.distill).toHaveBeenCalledTimes(1); expect(fixture.distill.mock.calls[0][0].chunks[0].headingPath).toContain('Changed meaning');
  fixture.distill.mockClear(); writeFileSync(file, `## api_key: sk-proj-${'z'.repeat(40)}\n${text('Apricot')}`);
  await indexKnowledgeSources(); expect(fixture.distill).not.toHaveBeenCalled(); expect(facts()).toEqual([]);
});

it.each(['answer', 'stream'])('refuses an in-flight %s after its source is removed', async mode => {
  writeFileSync(path.join(folder, 'plan.md'), text('Apricot')); const source = await add(folder);
  let entered!: () => void; let finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixture.compose.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); });
  const { askCortex, runAskPipeline } = await import('@/lib/cortex/qa/ask');
  const emitted: unknown[] = [];
  const pending = mode === 'answer' ? askCortex('Apricot', undefined, { bypassCache: true })
    : runAskPipeline('Apricot', undefined, (name, payload) => { if (name === 'token' || name === 'citation') emitted.push(payload); }, true);
  await started;
  expect((await sourcesApi.POST(request({ action: 'remove', id: source.id }))).status).toBe(200);
  const refusal = expect(pending).rejects.toThrow('Knowledge sources changed'); finish(); await refusal;
  expect(emitted).toEqual([]);
});

it('reads persisted source settings in a fresh process after restart', async () => {
  const source = await add(folder, { name: 'Restart notes' });
  const { spawn } = await import('node:child_process');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', '--input-type=module', '-e',
      "const module = await import('./src/lib/operator/defaults.ts'); const { getOperatorDefaultsSync } = module.default ?? module; process.stdout.write(JSON.stringify(getOperatorDefaultsSync().values.knowledgeSources));"], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`Restart exit ${code}: ${stderr}`)));
  });
  expect(JSON.parse(output)).toEqual([expect.objectContaining({ id: source.id, path: folder, name: 'Restart notes' })]);
}, 20_000);


it('refuses lead admission into an unlisted Git knowledge vault before recording or launching a writable turn', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', folder], { stdio: 'ignore' });
  await add(folder);
  const { POST: leadPost } = await import('@/app/api/orchestrator/lead/route');
  const { listRepos } = await import('@/lib/repos/registry');
  expect(await listRepos()).toEqual([]);
  const alias = path.join(fixture.root, `alias-${crypto.randomUUID()}`); symlinkSync(folder, alias, 'dir');
  const child = path.join(folder, 'nested'); mkdirSync(child);
  const before = getSqlite().prepare('SELECT count(*) AS n FROM orchestrator_leads').get();
  const turnsBefore = getSqlite().prepare('SELECT count(*) AS n FROM orchestrator_lead_turns').get();
  fixture.sendLead.mockClear();
  for (const repoPath of [folder, child, alias]) {
    const response = await leadPost(request({ action: 'start', repoPath, backend: 'codex', model: 'gpt-5.6-sol', effort: 'high', idempotencyKey: crypto.randomUUID(),
      brief: { objective: 'Inspect knowledge', scope: ['notes'], doneTests: ['Read only'], nonGoals: [], budgets: [], escalationCriteria: ['Any write'] } }, true, '/api/orchestrator/lead'));
    if (response.status === 202) {
      const accepted = await response.clone().json();
      await leadPost(request({ action: 'stop', leadId: accepted.lead.id }, true, '/api/orchestrator/lead'));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'invalid_lead_repo', message: expect.stringContaining('read-only') });
  }
  expect(getSqlite().prepare('SELECT count(*) AS n FROM orchestrator_leads').get()).toEqual(before);
  expect(getSqlite().prepare('SELECT count(*) AS n FROM orchestrator_lead_turns').get()).toEqual(turnsBefore);
  expect(fixture.sendLead).not.toHaveBeenCalled();
  expect(await listRepos()).toEqual([]);
});
