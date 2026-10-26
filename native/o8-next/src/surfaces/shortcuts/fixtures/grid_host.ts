/** Extend the existing Grid peer with the sidebar's production archive reader. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { NextRequest } from 'next/server';

let host: ReturnType<typeof spawn> | undefined;
async function main() {
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
    '--import', 'tsx', 'scripts/next/grid-dev-server.ts', '--terminals'], {
    stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
  });
  host = child;
  const lines = createInterface({ input: child.stdout });
  const receipt = await new Promise<{ origin: string; workspace: string }>((resolve, reject) => {
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.origin && value.workspace) resolve(value);
      } catch { /* Read only the existing host's readiness receipt. */ }
    });
    child.once('exit', () => reject(new Error('Owned Grid host exited before readiness')));
    child.once('error', reject);
  });
  const dataDir = join(dirname(receipt.workspace), 'data');
  Object.assign(process.env, { O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), NODE_ENV: 'test' });
  const { GET: list } = await import('../../../../../../src/app/api/v2/chat-history/list/route');
  const { panelGateMiddleware } = await import('../../../../../../src/middleware');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', receipt.origin);
      let response: Response;
      if (req.method === 'GET' && url.pathname === '/api/v2/chat-history/list') {
        const request = new NextRequest(url, { headers: { host: url.host,
          'x-o8-client-addr': '127.0.0.1',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
        const gate = panelGateMiddleware(request);
        response = gate.status === 200 ? await list(request) : gate;
      } else {
        response = await fetch(new URL(url.pathname + url.search, receipt.origin), {
          headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
        });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('Owned Grid route failed'); }
  });
  async function close() {
    server.closeAllConnections();
    server.close();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    lines.close();
    process.exit(0);
  }
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  child.once('exit', () => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned proxy port');
  process.stdout.write(JSON.stringify({ ...receipt, origin: `http://127.0.0.1:${address.port}` }) + '\n');
}
void main().catch(() => {
  host?.kill('SIGTERM');
  console.error('Owned Grid fixture failed');
  process.exitCode = 1;
});
