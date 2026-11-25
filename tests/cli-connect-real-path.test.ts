import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type RegistryMode = 'normal' | 'device_cap' | 'unsupported';

interface Device {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-connect-cli-'));
const installId = 'install_real_path';
const licenseToken = 'fixture-license-token';
const localToken = 'fixture-local-token';
const servers: Server[] = [];
let registryMode: RegistryMode = 'normal';
let devices: Device[] = [];
let localApiPort = 0;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return address.port;
}

function fixtureDevice(id: string, name: string, deviceInstallId = `install_${id}`): Device {
  return {
    machineId: id,
    installId: deviceInstallId,
    name,
    platform: 'darwin',
    appVersion: '0.1.631',
    createdAt: '2026-07-29T10:00:00.000Z',
    lastSeenAt: '2026-07-29T10:00:00.000Z',
  };
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'cli/dist/o8.mjs'),
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_API_PORT: String(localApiPort),
        O8_API_TOKEN: localToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  writeFileSync(path.join(dataDir, 'install-id'), `${installId}\n`);
  writeFileSync(path.join(dataDir, 'entitlement.json'), JSON.stringify({
    plan: 'free',
    status: 'active',
    licenseKey: licenseToken,
  }));

  const registryServer = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${licenseToken}`) {
      json(response, 401, { error: 'wrong registry bearer' });
      return;
    }
    if (registryMode === 'unsupported') {
      json(response, 404, { error: 'not implemented' });
      return;
    }
    if (request.method === 'POST' && request.url === '/machines/register') {
      if (registryMode === 'device_cap') {
        json(response, 409, { reason: 'device_cap', deviceCap: 3, devices });
        return;
      }
      const body = JSON.parse(await readBody(request)) as {
        installId: string;
        name: string;
        platform: string;
        appVersion: string;
      };
      const registered = fixtureDevice('machine_current', body.name, body.installId);
      registered.platform = body.platform;
      registered.appVersion = body.appVersion;
      devices = [registered];
      json(response, 200, { machineId: registered.machineId, deviceCap: 3, devices });
      return;
    }
    if (request.method === 'GET' && request.url === '/machines') {
      json(response, 200, devices);
      return;
    }
    if (request.method === 'DELETE' && request.url?.startsWith('/machines/')) {
      const machineId = decodeURIComponent(request.url.slice('/machines/'.length));
      devices = devices.filter((device) => device.machineId !== machineId);
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { error: 'missing registry fixture route' });
  });
  const registryPort = await listen(registryServer);
  process.env.O8_PROXY_URL = `http://127.0.0.1:${registryPort}`;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;

  const connectRoute = await import('../src/app/api/panel/connect/route');
  const localApiServer = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${localToken}`) {
      json(response, 401, { error: 'wrong local bearer' });
      return;
    }
    const method = request.method as 'GET' | 'POST' | 'DELETE';
    const handler = connectRoute[method];
    if (!handler || request.url !== '/api/panel/connect') {
      json(response, 404, { error: 'missing local fixture route' });
      return;
    }
    const body = await readBody(request);
    const routeResponse = await handler(new Request('http://localhost/api/panel/connect', {
      method,
      headers: request.headers as HeadersInit,
      body: body || undefined,
    }));
    response.writeHead(routeResponse.status, {
      'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json',
    });
    response.end(await routeResponse.text());
  });
  localApiPort = await listen(localApiServer);
});

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => (
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  )));
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.O8_PROXY_URL;
  delete process.env.CORTEX_IDE_DATA_DIR;
});

describe('o8 connect CLI real path', () => {
  it('registers, reads status, and disconnects through the real route and registry client', async () => {
    registryMode = 'normal';
    devices = [];

    const connected = await runCli(['connect']);
    expect(connected.exitCode, connected.stderr).toBe(0);
    expect(JSON.parse(connected.stdout)).toMatchObject({
      schema: 'o8/cli/connect/v1',
      ok: true,
      machineId: 'machine_current',
      deviceCap: 3,
    });

    const status = await runCli(['connect', '--status']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      schema: 'o8/cli/connect-status/v1',
      ok: true,
      currentMachineId: 'machine_current',
      devices: [{ machineId: 'machine_current', installId }],
    });

    const disconnected = await runCli(['disconnect']);
    expect(disconnected.exitCode, disconnected.stderr).toBe(0);
    expect(JSON.parse(disconnected.stdout)).toMatchObject({
      schema: 'o8/cli/disconnect/v1',
      ok: true,
      machineId: 'machine_current',
    });
    expect(devices).toEqual([]);
  }, 30_000);

  it('registers under a generic name by default and under a name the user chose, never the host name', async () => {
    registryMode = 'normal';
    devices = [];
    rmSync(path.join(dataDir, 'computer-name'), { force: true });

    const connected = await runCli(['connect']);
    expect(connected.exitCode, connected.stderr).toBe(0);
    const generic = ({ darwin: 'Mac', win32: 'Windows PC', linux: 'Linux computer' } as Record<string, string>)[process.platform] ?? 'Computer';
    expect(JSON.parse(connected.stdout)).toMatchObject({ ok: true, name: generic });
    expect(devices[0]?.name).toBe(generic);
    expect(devices[0]?.name).not.toBe(os.hostname());

    const renamed = await runCli(['connect', '--name', 'Studio']);
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({ ok: true, name: 'Studio', machineId: 'machine_current' });
    expect(devices.map((device) => device.name)).toEqual(['Studio']);
    expect(readFileSync(path.join(dataDir, 'computer-name'), 'utf8')).toBe('Studio\n');

    const blank = await runCli(['connect', '--name', '   ']);
    expect(blank.exitCode).not.toBe(0);
    expect(devices.map((device) => device.name)).toEqual(['Studio']);
    rmSync(path.join(dataDir, 'computer-name'), { force: true });
  }, 30_000);

  it('renders the three-device cap with the device list and recovery command', async () => {
    registryMode = 'device_cap';
    devices = [
      fixtureDevice('machine_1', 'Studio Mac'),
      fixtureDevice('machine_2', 'Travel Mac'),
      fixtureDevice('machine_3', 'Mac mini'),
    ];

    const result = await runCli(['connect', '--human']);

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('Free accounts can connect up to 3 devices.');
    expect(result.stderr).toContain('Studio Mac');
    expect(result.stderr).toContain('Travel Mac');
    expect(result.stderr).toContain('Mac mini');
    expect(result.stderr).toContain('o8 disconnect');
  }, 30_000);

  it('reports an unsupported registry without hiding the server rollout boundary', async () => {
    registryMode = 'unsupported';

    const result = await runCli(['connect']);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: 'o8/cli/connect/v1',
      ok: false,
      error: {
        code: 'unsupported',
        message: 'The o8 license server does not support machine registry yet.',
      },
    });
  }, 30_000);

  it('rejects positional arguments instead of silently registering a machine', async () => {
    registryMode = 'normal';

    const result = await runCli(['connect', 'unexpected']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: 'o8/cli/error/v1',
      error: {
        code: 'invalid_args',
        message: 'Unknown connect flag: unexpected',
      },
    });
  }, 30_000);
});
