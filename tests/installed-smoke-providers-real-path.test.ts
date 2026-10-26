import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const root = mkdtempSync(join(tmpdir(), 'o8-smoke-provider-'));
const home = join(root, 'profile');
mkdirSync(home);
vi.stubEnv('HOME', home);
vi.stubEnv('CODEX_HOME', join(home, '.codex'));
vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'));
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
for (const [kind, key] of [['codex', 'O8_CODEX_BIN'], ['claude', 'O8_CLAUDE_CODE_BIN']]) {
  const path = join(root, `${kind}-fixture.mjs`);
  copyFileSync('scripts/fixtures/installed-smoke-provider.mjs', path);
  chmodSync(path, 0o700);
  vi.stubEnv(key, path);
}
const repo = join(home, 'repo');
mkdirSync(repo);
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'README.md'), 'Disposable provider fixture.\n');
execFileSync('git', ['-C', repo, 'add', 'README.md']);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture']);
const { codexBackend } = await import('@/lib/lane/orchestrator-backends/codex');
const { claudeBackend } = await import('@/lib/lane/orchestrator-backends/claude');
const { getOrchestratorSession } = await import('@/lib/lane/orchestrator-session');
const threads: string[] = [];
afterAll(() => {
  for (const thread of threads) getOrchestratorSession(repo, thread)?.proc?.kill('SIGTERM');
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it.each([codexBackend, claudeBackend])('completes a turn through the production $id backend with the shipped offline provider', async backend => {
  const threadId = `thoughts-smoke-${randomUUID()}`;
  threads.push(threadId);
  const sentinel = `o8_smoke_${randomUUID()}`;
  const events: OrchestratorEvent[] = [];
  await backend.sendTurn(repo, `Reply with exactly ${sentinel}.`, event => events.push(event), {
    threadId, permissionMode: 'plan', orchestrationMode: 'fleet',
  });
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.filter(event => event.type === 'text').map(event => event.text).join('').trim()).toBe(sentinel);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminalOutcome: 'completed' }));
}, 30_000);

it('dispatches and verifies a worker through the production launch, transcript and inventory routes', async () => {
  const { createServer } = await import('node:http');
  const { NextRequest } = await import('next/server');
  const launch = await import('@/app/api/runtime/launch/route');
  const transcript = await import('@/app/api/runtime/transcript/route');
  const inventory = await import('@/app/api/runtime/inventory/route');
  const { workerDispatch } = await import('../scripts/lib/installed-smoke-client.mjs');
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    const url = `http://127.0.0.1${req.url}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(url, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    try {
      const response = req.url?.startsWith('/api/runtime/launch') ? await launch.POST(request)
        : req.url?.startsWith('/api/runtime/transcript') ? await transcript.GET(request)
          : await inventory.GET(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  vi.stubEnv('O8_API_PORT', String(address.port));
  vi.stubEnv('O8_API_TOKEN', token);
  try { await workerDispatch({ apiPort: address.port, token, repoPath: repo, timeout: 15_000 }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);
