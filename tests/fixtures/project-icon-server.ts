// Isolated HTTP fixture: production routes and SQLite, never the installed server.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  let repos: typeof import('../../src/app/api/panel/repos/route');
  const server = createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const url = new URL(incoming.url!, origin);
      if (url.pathname === '/internal/realtime') {
        outgoing.writeHead(200); outgoing.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(url, {
        method: incoming.method,
        headers: Object.fromEntries(Object.entries(incoming.headers).flatMap(([key, value]) => value ? [[key, String(value)]] : [])),
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      let response: Response;
      if (url.pathname === '/api/panel/repos') {
        response = incoming.method === 'POST' ? await repos.POST(request) : await repos.GET(request);
      } else response = new Response('Not found', { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500); outgoing.end('Fixture route failed');
    }
  });
  server.listen(0, '127.0.0.1', async () => {
    const port = (server.address() as { port: number }).port;
    process.env.PORT = process.env.O8_API_PORT = String(port);
    process.env.O8_API_BASE = process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = `http://127.0.0.1:${port}`;
    writeFileSync(join(process.env.O8_DATA_DIR!, 'api-port'), String(port));
    repos = await import('../../src/app/api/panel/repos/route');
    process.send?.({ port });
  });
  process.on('disconnect', () => process.exit(0));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
void main();
