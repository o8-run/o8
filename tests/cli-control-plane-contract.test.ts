import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const dataDir = mkdtempSync(join(tmpdir(), 'o8-cli-contract-'));
const askBodies: Array<Record<string, unknown>> = [];
let apiServer: Server | null = null;
let apiPort = 0;

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_API_PORT: String(apiPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

beforeAll(async () => {
  execFileSync(process.execPath, [join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  apiServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/panel/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '0.1.test', nodeVersion: process.version }));
      return;
    }
    if (requestUrl.pathname === '/api/cortex/ask/answer' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      askBodies.push(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        answer: `asked: ${String(body.question)}`,
        citations: [],
        class: 'A',
      }));
      return;
    }
    if (requestUrl.pathname === '/api/orchestrator/create-mission' && request.method === 'POST') {
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { missionId: 'mission-held', packets: [{ id: 'pkt-held', title: 'held', wave: 1 }] } }));
      return;
    }
    if (requestUrl.pathname === '/api/orchestrator/dispatch' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // A mission with a lifecycle hold is answered as the server answers it, with an idempotency key.
      response.end(JSON.stringify({
        ok: true,
        result: body.missionId === 'mission-held'
          ? { initiated: false, async: true, missionId: 'mission-held', blocked: true }
          : { initiated: true, async: true, missionId: null },
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'missing fixture route' }));
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('CLI contract fixture did not bind');
  apiPort = address.port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => error ? reject(error) : resolveClose());
  });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('o8 CLI control-plane contracts', () => {
  it('supports the standard root --version flag', async () => {
    const result = await runCli(['--version']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'o8/cli/version/v1',
      serverVersion: '0.1.test',
      serverReachable: true,
    });
  });

  it('preserves ask questions with valued flags before or after them', async () => {
    const questionFirst = await runCli(['ask', 'Question first', '--repo', '/tmp/repo-a', '--terse']);
    const flagsFirst = await runCli(['ask', '--repo', '/tmp/repo-b', 'Flags first']);

    expect(questionFirst.exitCode, questionFirst.stderr).toBe(0);
    expect(flagsFirst.exitCode, flagsFirst.stderr).toBe(0);
    expect(askBodies).toEqual([
      expect.objectContaining({ question: 'Question first', repoPath: '/tmp/repo-a', terse: true }),
      expect.objectContaining({ question: 'Flags first', repoPath: '/tmp/repo-b' }),
    ]);
  });

  it('rejects an async dispatch response that did not resolve a mission', async () => {
    const result = await runCli(['mission', 'dispatch']);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: 'o8/cli/error/v1',
      error: { code: 'dispatch_not_initiated' },
    });
  });

  it('fails mission create --dispatch on a held dispatch the way mission dispatch does, after printing the mission', async () => {
    const created = await runCli(['mission', 'create', '--title', 'held', '--body', 'x', '--repo', process.cwd(), '--dispatch']);
    const dispatched = await runCli(['mission', 'dispatch', '--mission', 'mission-held']);

    for (const result of [created, dispatched]) {
      expect(result.exitCode, result.stderr).toBe(5);
      expect(JSON.parse(result.stderr)).toMatchObject({ schema: 'o8/cli/error/v1', error: { code: 'dispatch_blocked' } });
    }
    expect(JSON.parse(created.stdout)).toMatchObject({ mission: { missionId: 'mission-held' }, dispatch: { blocked: true } });
    expect(JSON.parse(created.stderr).error.message).toContain('o8 mission dispatch --mission mission-held');
  });
});
