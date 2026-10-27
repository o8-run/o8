/** Next serves the real app. API reads are sent to the existing fixture host by the browser. */
import next from 'next';
import { createServer } from 'node:http';

async function main() {
  const app = next({ dev: true, dir: process.cwd() });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    // Do not invoke startup, discovery or mutation routes in this render process.
    if (request.url?.startsWith('/api/')) { response.writeHead(404).end(); return; }
    void handle(request, response);
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Next listener');
  console.log(JSON.stringify({ webOrigin: `http://127.0.0.1:${address.port}` }));
  const close = () => { server.closeAllConnections(); server.close(); void app.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
void main().catch(() => { console.error('Parity Next server failed'); process.exitCode = 1; });
