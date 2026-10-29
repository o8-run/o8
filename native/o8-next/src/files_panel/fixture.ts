// Owned HTTP host for native Files tests. Imports the production route handlers.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

async function main() {
const root = process.env.O8_FILES_FIXTURE_ROOT!;
const repo = join(root, 'repo');
const home = join(root, 'home');
const data = join(root, 'data');
for (const path of [join(repo, 'src'), join(home, '.codex'), data]) mkdirSync(path, { recursive: true });
Object.assign(process.env, { HOME: home, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'fixture.db'), NODE_ENV: 'test' });
for (const key of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN']) delete process.env[key];
writeFileSync(join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'files-fixture', localPath: repo, name: 'files-fixture', createdAt: '2026-10-29', updatedAt: '2026-10-29' }] }));
for (const [path, content] of [
  [join(repo, 'src/useful.rs'), 'fn useful() {}'], [join(repo, 'AGENTS.md'), 'repo instructions'],
  [join(home, '.codex/AGENTS.md'), 'global instructions'],
  [join(repo, '.gitignore'), 'PARITY-BOARD.local.md\n'], [join(repo, 'PARITY-BOARD.local.md'), 'ignored but visible'],
]) writeFileSync(path, content);
execFileSync('git', ['init', '-q', repo]);
const files = await import('../../../../src/app/api/panel/files/route');
const docs = await import('../../../../src/app/api/v2/files/quick-docs/route');
const preview = await import('../../../../src/app/api/v2/files/route');
const log: string[] = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    log.push(`${req.method} ${url.pathname}${url.search}`);
    writeFileSync(join(root, 'requests.json'), JSON.stringify(log));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const route = url.pathname;
    const response = route === '/api/v2/files/quick-docs' ? await docs.GET(request)
        : route === '/api/v2/files' ? await preview.GET(request) : await files.GET(request);
    // Exercise stale completion: the earlier query/file finishes last.
    if (url.searchParams.get('search') === 'slow' || url.searchParams.get('path') === 'AGENTS.md') await new Promise(resolve => setTimeout(resolve, 250));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch { res.writeHead(500).end('{}'); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, repo }));
});

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
