import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('keeps the generated Next wrapper boundary on the public Host and preserves remote relay refusals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-front-door-wrapper-'));
  const source = readFileSync('scripts/tauri-export.mjs', 'utf8');
  const prefix = "writeFileSync(join(server, 'server.js'), ";
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf("\nconsole.log('📦 Wrote server.js wrapper", start);
  const template = source.slice(start, end).trim().replace(/\);$/, '');
  const wrapper = runInNewContext(template, Object.fromEntries([
    'RELEASE_ENV_STANZA', 'SENTRY_ENV_STANZA', 'APP_VERSION_STANZA', 'BUILD_GIT_SHA_STANZA', 'BOOT_CAPTURE_STANZA',
  ].map(name => [name, ''])));
  writeFileSync(join(directory, 'server.js'), wrapper);
  // Native-addon selection is outside this socket-boundary test; the actual
  // generated HTTP wrapper and its actual host/relay rules execute unchanged.
  writeFileSync(join(directory, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => {};');
  for (const file of ['http-request-boundary.cjs', 'lan-access.cjs']) copyFileSync('scripts/lib/' + file, join(directory, file));
  writeFileSync(join(directory, 'server-impl.js'), `
const http = require('node:http');
const server = http.createServer((req, res) => res.end(JSON.stringify({ peer: req.headers['x-o8-client-addr'] })));
server.listen(0, '127.0.0.1', () => { process.env.PORT = String(server.address().port); process.send({ port: server.address().port }); });
`);
  const publicLease = createServer();
  await new Promise<void>(resolve => publicLease.listen(0, '127.0.0.1', resolve));
  const publicPort = (publicLease.address() as { port: number }).port;
  let child: ChildProcess | undefined;
  const call = (privatePort: number, host: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: privatePort, path: '/', method, headers: { host, ...headers } }, res => {
        let body = ''; res.on('data', bytes => { body += bytes; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      }); req.setTimeout(5000, () => req.destroy(new Error('Wrapper request timeout'))); req.on('error', reject); req.end();
    });
  try {
    for (const flag of ['0', '1']) {
      child = spawn(process.execPath, [join(directory, 'server.js')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: directory, CORTEX_IDE_DATA_DIR: directory,
          PORT: '0', O8_API_PORT: String(publicPort), O8_API_FRONT_DOOR: flag } });
      const receipt = await Promise.race([once(child, 'message'), new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Wrapper boot timeout')), 10_000); timer.unref();
      })]);
      const privatePort = (receipt[0] as { port: number }).port;
      const expectedPort = flag === '1' ? publicPort : privatePort;
      const host = `127.0.0.1:${expectedPort}`;
      const local = await call(privatePort, host, { 'x-o8-client-addr': '127.0.0.9' });
      expect(local.status).toBe(200); expect(JSON.parse(local.body)).toEqual({ peer: '127.0.0.1' });
      const remote = await call(privatePort, host, { 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.1' });
      expect(remote.status).toBe(200); expect(JSON.parse(remote.body)).toEqual({ peer: 'o8-relay-forward' });
      expect((await call(privatePort, 'untrusted.invalid')).status).toBe(421);
      expect((await call(privatePort, host, { origin: 'https://untrusted.invalid' }, 'POST')).status).toBe(403);
      if (flag === '1') expect((await call(privatePort, `127.0.0.1:${privatePort}`)).status).toBe(421);
      const stopped = once(child, 'exit'); child.kill(); await stopped; child = undefined;
    }
  } finally {
    if (child?.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await new Promise<void>(resolve => publicLease.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
