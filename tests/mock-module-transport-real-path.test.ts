import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { interceptorPlugin } from '@vitest/mocker/node';
import WebSocket from 'ws';
import { expect, it } from 'vitest';

it('keeps a registered mock module URL as data through the live transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o8-mock-transport-'));
  await writeFile(join(root, 'target.js'), 'export const value = 1;');
  const server = await createServer({
    configFile: false, root, logLevel: 'silent',
    plugins: [interceptorPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  let socket: WebSocket | undefined;
  const marker = '__o8MockTransportMarker';
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.__vitest_mocker__;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    socket = new WebSocket(`${origin.replace('http:', 'ws:')}/?token=${server.config.webSocketToken}`, 'vite-hmr');
    const connected = socket;
    const registered = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Registration timed out')), 5_000);
      connected.on('message', bytes => {
        const message = JSON.parse(String(bytes));
        if (message.event === 'vitest:interceptor:register:result') { clearTimeout(timeout); resolve(); }
        if (message.event === 'vitest:interceptor:resolve') {
          connected.send(JSON.stringify({ type: 'custom', event: 'vitest:interceptor:resolved', data: { url: message.data, keys: [] } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => { connected.once('open', resolve); connected.once('error', reject); });
    connected.send(JSON.stringify({ type: 'custom', event: 'vitest:interceptor:register', data: {
      type: 'manual', raw: './target.js', id: join(root, 'target.js'),
      url: `"); globalThis.${marker} = true; //`,
    } }));
    await registered;
    const response = await fetch(`${origin}/target.js`);
    expect(response.status).toBe(200);
    // Load the actual served module in a separate ESM namespace.
    const served = join(root, 'served.mjs');
    await writeFile(served, await response.text());
    globals.__vitest_mocker__ = { getFactoryModule: async () => ({}) };
    await import(/* @vite-ignore */ pathToFileURL(served).href);
    expect(globals[marker]).toBeUndefined();
  } finally {
    globals.__vitest_mocker__ = previous;
    delete globals[marker];
    socket?.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
