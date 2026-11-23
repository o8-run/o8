import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A repository registered under ~/Documents waits on macOS's privacy prompt
// until the user answers it. The real server must keep answering /health and
// unrelated routes meanwhile; the stand-in prompt blocks every filesystem
// call under that folder on a FIFO, sync calls on the event loop itself.
const root = mkdtempSync(join(tmpdir(), 'o8-prompt-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const blockedRepo = join(home, 'Documents', 'blocked-repo');
const plainRepo = join(root, 'plain-repo');
const fifo = join(root, 'prompt.fifo');
let token = '';
let server: ChildProcess | null = null;
let output = '';
let origin = '';

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener port');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function timed(path: string, budgetMs: number) {
  const started = Date.now();
  try {
    const response = await fetch(origin + path, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(budgetMs),
    });
    await response.arrayBuffer();
    return { path, status: response.status, ms: Date.now() - started };
  } catch {
    return { path, status: 0, ms: Date.now() - started };
  }
}

function answerPrompt() {
  // Releases every thread parked on the prompt; ENXIO means none is waiting.
  try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader */ }
}

beforeAll(async () => {
  for (const repo of [blockedRepo, plainRepo]) {
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://github.com/example/${repo === plainRepo ? 'plain' : 'blocked'}.git`]);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
  }
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ repos: [
    { id: 'plain', name: 'plain-repo', localPath: plainRepo, isGitRepo: true, remoteUrl: 'https://github.com/example/plain.git' },
    { id: 'blocked', name: 'blocked-repo', localPath: blockedRepo, isGitRepo: true, remoteUrl: 'https://github.com/example/blocked.git' },
  ] }));
  execFileSync('mkfifo', [fifo]);
  mkdirSync(join(root, 'bin'));
  for (const command of ['gh', 'claude', 'codex', 'tmux', 'lsof', 'pi', 'opencode']) {
    writeFileSync(join(root, 'bin', command), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  const apiPort = await freePort();
  let wsPort = await freePort();
  while (wsPort === apiPort) wsPort = await freePort();
  let nextPort = await freePort();
  while (nextPort === apiPort || nextPort === wsPort) nextPort = await freePort();
  server = spawn(process.execPath, [
    '--require=./tests/helpers/protected-folder-prompt-preload.cjs',
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8',
      NODE_ENV: 'test', TMPDIR: process.env.TMPDIR, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
      CORTEX_IDE_REVIEW_REPO_ROOT: plainRepo, CODEX_HOME: join(home, '.codex'),
      O8_API_PORT: String(apiPort), PORT: String(apiPort), O8_WS_PORT: String(wsPort), WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${nextPort}/`, O8_API_FRONT_DOOR: '1', O8_NEXT_OFF: '1', O8_NEXT_O8D: '0', O8_WS_O8D: '0',
      O8_LAN_ACCESS: '0', O8_CONNECT_ATTACH: 'off', O8_RELAY_CONNECTOR: 'off',
      O8_PROMPT_FOLDER: join(home, 'Documents'), O8_PROMPT_FIFO: fifo,
    },
  });
  server.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  server.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
  const deadline = Date.now() + 60_000;
  while (!origin && Date.now() < deadline && server.exitCode === null) {
    for (const port of [apiPort, wsPort]) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok) origin = `http://127.0.0.1:${port}`;
      } catch { /* booting */ }
    }
    if (!origin) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!origin) throw new Error(`Server never answered /health: ${output.slice(-3_000)}`);
  token = readFileSync(join(dataDir, 'ws-token'), 'utf8').trim();
}, 90_000);

afterAll(async () => {
  answerPrompt();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a repository waiting on a privacy prompt', () => {
  it('keeps /health and unrelated routes answering while the prompt is open', async () => {
    // Warm the routes once: tsx compiles each module on its first request.
    for (const path of ['/api/lanes', '/api/panel/repos', '/api/panel/supervisor-inbox', '/api/orchestrator/composer-queue']) await timed(path, 20_000);
    const slow: Array<{ path: string; status: number; ms: number }> = [];
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      // The window polls its chat's composer queue with the chat's repository,
      // and the repository list and inbox touch every registered repository.
      void timed(`/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(blockedRepo)}&threadId=thoughts-prompt-1`, 1_000);
      void timed('/api/panel/repos', 1_000);
      void timed('/api/panel/supervisor-inbox', 1_000);
      for (const result of await Promise.all([timed('/health', 1_000), timed('/api/lanes', 1_000)])) {
        if (result.status !== 200 || result.ms >= 1_000) slow.push(result);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(slow, output.slice(-3_000)).toEqual([]);
  }, 60_000);

  it('lists both repositories, and the blocked one is read once the prompt is answered', async () => {
    const listed = await fetch(`${origin}/api/panel/repos`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
    const { repos } = await listed.json() as { repos: Array<{ localPath: string; exists: boolean }> };
    expect(repos.map((repo) => repo.localPath).sort()).toEqual([blockedRepo, plainRepo].sort());
    answerPrompt();
    const health = await timed('/health', 1_000);
    expect(health.status).toBe(200);
  }, 30_000);
});
