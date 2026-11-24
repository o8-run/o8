import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = process.cwd();
let server: Server;
let dataDir: string;
let port: number;
async function cli(...args: string[]) {
  const env = { ...process.env };
  delete env.O8_WORKER_TOKEN;
  delete env.O8_WORKER_PACKET_ID;
  delete env.O8_SPECTATOR_TOKEN;
  return exec(process.execPath, [path.join(root, 'cli/dist/o8.mjs'), ...args], {
    cwd: dataDir,
    env: { ...env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(port), O8_API_TOKEN: 'standalone-fixture-token' },
    timeout: 15_000,
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'o8-cli-standalone-'));
  await exec(process.execPath, [path.join(root, 'cli/esbuild.config.mjs')], { timeout: 60_000 });
  // A protocol peer isolates CLI argument/output contracts from server admission.
  server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer standalone-fixture-token') {
      response.writeHead(401).end();
      return;
    }
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/setup/agent') {
      response.end(JSON.stringify({ ok: true, status: 'ready' }));
    } else {
      response.writeHead(404).end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  port = address.port;
}, 90_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('standalone CLI completion gates', () => {
  it('checks every CLI source and test with the standalone TypeScript project', async () => {
    const result = await exec(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit', '-p', 'cli/tsconfig.json'], {
      cwd: root, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
    });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  }, 190_000);

  it('returns success through the bundled setup dispatcher', async () => {
    const result = await cli('setup', 'status');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: 'ready' });
    expect(result.stderr).toBe('');
  });
});
