// Owned HTTP host for native Files tests. Imports the production route handlers.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as nodeModule from 'node:module';
// Runtime is Node 22.15+. The repository's older Node declarations omit this API.
type ResolveResult = { url: string; shortCircuit?: boolean };
const { registerHooks } = nodeModule as typeof nodeModule & { registerHooks(hooks: { resolve(specifier: string, context: object, nextResolve: (specifier: string, context: object) => ResolveResult): ResolveResult }): void };
import { NextRequest } from 'next/server';

async function main() {
const root = process.env.O8_FILES_FIXTURE_ROOT!;
registerHooks({ resolve(specifier, context, nextResolve) {
  const provider = /(?:claude-code\/(?:warm-repl-pool|one-shot-repl)|cortex\/qa\/llm\/codex-adapter)(?:\.[cm]?[jt]s)?$/;
  const stub = { url: new URL('./spec_provider_fixture.ts', import.meta.url).href, shortCircuit: true };
  if (provider.test(specifier)) return stub;
  const resolved = nextResolve(specifier, context);
  return provider.test(resolved.url) ? stub : resolved;
} });
const repo = join(root, 'repo');
const home = join(root, 'home');
const data = join(root, 'data');
for (const path of [join(repo, 'src'), join(home, '.codex'), data]) mkdirSync(path, { recursive: true });
Object.assign(process.env, { HOME: home, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'fixture.db'), NODE_ENV: 'test', WS_TOKEN: randomBytes(32).toString('hex') });
for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN']) delete process.env[key];
writeFileSync(join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'files-fixture', localPath: repo, name: 'files-fixture', createdAt: '2026-10-29', updatedAt: '2026-10-29' }] }));
for (const [path, content] of [
  [join(repo, 'src/useful.rs'), 'fn useful() {}'], [join(repo, 'AGENTS.md'), 'repo instructions'],
  [join(home, '.codex/AGENTS.md'), 'global instructions'],
  [join(repo, '.gitignore'), 'PARITY-BOARD.local.md\n'], [join(repo, 'PARITY-BOARD.local.md'), 'ignored but visible'],
]) writeFileSync(path, content);
execFileSync('git', ['init', '-q', repo]);
const provider = await import('../../../../src/lib/claude-code/one-shot-repl');
if (provider.defaultClaudeBin() !== 'owned-fixture-provider') throw new Error('Provider boundary was not isolated');
const files = await import('../../../../src/app/api/panel/files/route');
const docs = await import('../../../../src/app/api/v2/files/quick-docs/route');
const preview = await import('../../../../src/app/api/v2/files/route');
const asset = await import('../../../../src/app/api/panel/file-asset/route');
const fileIo = await import('../../../../src/app/api/panel/file-io/route');
const { getOrCreateWsToken } = await import('../../../../src/lib/ws-auth');
const token = getOrCreateWsToken();
const log: string[] = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    log.push(`${req.method} ${url.pathname}${url.search}`);
    writeFileSync(join(root, 'requests-next.json'), JSON.stringify(log));
    renameSync(join(root, 'requests-next.json'), join(root, 'requests.json'));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(url, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...(typeof req.headers['x-filename'] === 'string' ? { 'x-filename': req.headers['x-filename'] } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(['POST', 'PUT'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}) });
    const route = url.pathname;
    if (chunks.length) writeFileSync(join(root, 'last-body.json'), Buffer.concat(chunks));
    // Simulate an older server's incomplete fallback, enabled only by
    // the regression test. Other tests exercise the production handlers.
    const fallbackPath = join(root, 'fallback-files.json');
    const fallbackKey = url.searchParams.has('search') ? 'search' : url.searchParams.get('recursive') === 'files' ? 'flat' : null;
    const fallback = route === '/api/panel/files' && fallbackKey && existsSync(fallbackPath)
      ? JSON.parse(readFileSync(fallbackPath, 'utf8'))[fallbackKey] : null;
    const delayPath = join(root, 'save-delay-ms');
    if (['POST', 'PUT'].includes(req.method!) && existsSync(delayPath)) await new Promise(resolve => setTimeout(resolve, Number(readFileSync(delayPath, 'utf8'))));
    const fault = route === '/api/review/workspace' ? 'changes-error' : route === '/api/panel/file-diff' ? 'diff-error' : '';
    let delegateResponse: Response | null = null;
    if (route === '/api/orchestrator/delegate') {
      const historyPath = join(root, 'delegate-bodies.json');
      const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : [];
      history.push(JSON.parse(Buffer.concat(chunks).toString())); writeFileSync(historyPath, JSON.stringify(history));
      delegateResponse = existsSync(join(root, 'delegate-error')) ? Response.json({ok:false,error:'Owned fixture dispatch failed'}, {status:503}) : existsSync(join(root, 'delegate-progress')) && history.length === 1 ? Response.json({ok:true,status:'in_progress'}, {status:202}) : Response.json({ok:true,status:'pending_approval',approvalId:'fixture-approval'});
    }
    const picked = route === '/api/panel/file-io' && req.method === 'POST' || route === '/api/panel/browse-folder' && req.method === 'POST';
    // Only the OS dialog is replaced in this host. Its caller still uses the
    // classic endpoint and validates the returned target before loading it.
    let response = picked ? Response.json({ path: route === '/api/panel/file-io' ? join(repo, 'o8.md') : repo }) : route === '/api/runtime/inventory' ? Response.json({agents:[]}) : route === '/api/v2/chat-history/list' ? Response.json({conversations:[]}) : route === '/api/projects' ? Response.json({projects:[]}) : route === '/api/mobile/orchestrator/threads' ? Response.json({ threads: [] }) : route === '/api/orchestrator/state' ? Response.json({}) : route === '/api/panel/projects' ? Response.json({ activeProjectId: 'fixture', projects: existsSync(join(root, 'active-workspace')) ? [{ id: 'fixture', name: 'Fixture', repoPaths: [repo] }] : [] }) : route === '/api/panel/repos' ? Response.json({ repos: [{ id: 'files-fixture', name: 'Fixture', localPath: repo, exists: true }] }) : route === '/api/health' ? Response.json({ ok: true }) : route === '/api/workspaces' ? Response.json({ workspaces: [] }) : route === '/api/sessions' ? Response.json({ sessions: [] }) : route === '/api/repo-spec/asset' ? await (await import('../../../../src/app/api/repo-spec/asset/route')).POST(request) : route === '/api/orchestrator/delegate' ? delegateResponse! : route === '/api/repo-spec' ? await (await import('../../../../src/app/api/repo-spec/route'))[req.method as 'GET' | 'PUT' | 'POST'](request) : fault && existsSync(join(root, fault)) ? Response.json({ error: 'Owned fixture unavailable' }, { status: 503 }) : route === '/api/review/workspace' ? await (await import('../../../../src/app/api/review/workspace/route')).GET(request) : route === '/api/panel/file-diff' ? await (await import('../../../../src/app/api/panel/file-diff/route')).GET(request) : fallback ? Response.json(fallback) : route === '/api/v2/files/quick-docs' ? await docs.GET(request)
        : route === '/api/v2/files' ? req.method === 'POST' ? await preview.POST(request) : await preview.GET(request) : route === '/api/panel/file-io' ? req.method === 'PUT' ? await fileIo.PUT(request) : await fileIo.GET(request) : route === '/api/panel/file-asset' ? await asset.GET(request) : await files.GET(request);
    if (req.method === 'GET' && route === '/api/v2/files' && existsSync(join(root, 'omit-content-hash'))) {
      const status = response.status; const body = await response.json(); delete body.contentHash;
      response = Response.json(body, { status });
    }
    // Exercise stale completion: the earlier query/file finishes last.
    if (url.searchParams.get('search') === 'slow' || url.searchParams.get('path') === 'AGENTS.md') await new Promise(resolve => setTimeout(resolve, 250));
    if (route === '/api/panel/file-diff' && existsSync(join(root, 'legacy-staged-diff')) && response.ok) {
      const body = await response.json(); body.stagedDiff = body.diff; body.diff = ''; response = Response.json(body);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('{}'); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, repo, token }));
});

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
