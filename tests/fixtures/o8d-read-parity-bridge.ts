import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
export async function startReadParityBridge(binary: string, port: number, native: boolean, product = false) {
  Object.assign(process.env, { O8_NEXT_O8D: product ? undefined : '1', O8_API_FRONT_DOOR: product ? '1' : undefined, O8_WS_O8D: '1',
    O8D_NATIVE_SESSION_READS: product ? undefined : native ? '1' : '0', O8D_BINARY: binary,
    O8_API_PORT: String(port), O8_WS_PORT: String(port), PORT: String(port) });
  if (product) { delete process.env.O8_NEXT_O8D; delete process.env.O8D_NATIVE_SESSION_READS; }
  else delete process.env.O8_API_FRONT_DOOR;
  const probes: Array<{ path: string; status: number }> = [];
  const server = createServer(async (req, res) => {
    if (bridge.bridged(req) && req.headers['x-o8d-session-read'] === 'authorize') {
      res.once('finish', () => probes.push({ path: req.url ?? '', status: res.statusCode }));
    }
    try {
      if (!await handleNativeHttp(req, res, port, bridge.bridged(req), product && !native ? req.socket.remoteAddress ?? null : bridge.clientAddress(req))) res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  const bridge = new O8dBridge(server, port, 'saved-read-parity-epoch', '127.0.0.1');
  if (product && !native) await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  else {
    await bridge.start();
    if (bridge.status.transport !== 'o8d') throw new Error('Public fixture did not start o8d');
    if (product && process.platform === 'linux') {
      // Inspect only selection flags, never print the daemon's environment.
      const flags = Object.fromEntries(readFileSync(`/proc/${bridge.status.pid}/environ`, 'utf8').split('\0')
        .filter(entry => /^(O8D_NATIVE_OWNED|O8D_NATIVE_SESSION_READS|O8_NEXT_O8D)=/.test(entry)).map(entry => entry.split('=')));
      assert.deepEqual(flags, { O8D_NATIVE_OWNED: '1' });
    }
  }
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
