/** Next serves the real app. API reads are sent to the existing fixture host by the browser. */
import next from 'next';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Claim a free loopback port before Next prepares. Next otherwise stamps its
 * default port (3000) into `request.nextUrl.port`, which no longer matches the
 * real socket port, and the app's loopback host gate (#4814) refuses the
 * request with HTTP 421. Passing the real port to `next({ port })` keeps
 * `nextUrl.port` aligned with the socket so the gate accepts the warm/capture
 * requests — without widening which hosts or ports the gate allows.
 */
function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo | null;
      if (!address) { reject(new Error('Missing probe listener')); return; }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export async function main(): Promise<{ webOrigin: string; port: number; shutdown: () => Promise<void> }> {
  const port = await reserveLoopbackPort();
  const app = next({ dev: true, dir: process.cwd(), hostname: '127.0.0.1', port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    // Do not invoke startup, discovery or mutation routes in this render process.
    if (request.url?.startsWith('/api/')) { response.writeHead(404).end(); return; }
    void handle(request, response);
  });
  await new Promise<void>(ready => server.listen(port, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Next listener');
  const webOrigin = `http://127.0.0.1:${address.port}`;
  console.log(JSON.stringify({ webOrigin }));
  const shutdown = async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await app.close();
  };
  const closeAndExit = () => { void shutdown().finally(() => process.exit(0)); };
  process.once('SIGTERM', closeAndExit);
  process.once('SIGINT', closeAndExit);
  return { webOrigin, port: address.port, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(() => { console.error('Parity Next server failed'); process.exitCode = 1; });
}
