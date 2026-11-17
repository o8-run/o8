import { createServer } from 'node:http';
import { O8dBridge } from '../../src/lib/ws-server/o8d-bridge';
import { handleNativeHttp } from '../../src/lib/ws-server/native-http-routes';

export async function freeReadParityPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Every phase launches a child with its actual immutable native-read flag. */
export async function startReadParityBridge(binary: string, port: number, native: boolean) {
  Object.assign(process.env, { O8_NEXT_O8D: '1', O8_WS_O8D: '1',
    O8D_NATIVE_SESSION_READS: native ? '1' : '0', O8D_BINARY: binary,
    O8_API_PORT: String(port), O8_WS_PORT: String(port), PORT: String(port) });
  const probes: Array<{ path: string; status: number }> = [];
  const server = createServer(async (req, res) => {
    if (bridge.bridged(req) && req.headers['x-o8d-session-read'] === 'authorize') {
      res.once('finish', () => probes.push({ path: req.url ?? '', status: res.statusCode }));
    }
    try {
      if (!await handleNativeHttp(req, res, port, bridge.bridged(req), bridge.clientAddress(req))) res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  const bridge = new O8dBridge(server, port, 'saved-read-parity-epoch', '127.0.0.1');
  await bridge.start();
  if (bridge.status.transport !== 'o8d') throw new Error('Public fixture did not start o8d');
  return { origin: `http://127.0.0.1:${port}`, probes, async stop() {
    bridge.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (let attempt = 0; attempt < 100 && bridge.status.pid !== null; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (bridge.status.pid !== null) throw new Error('Owned parity daemon did not exit');
  } };
}
