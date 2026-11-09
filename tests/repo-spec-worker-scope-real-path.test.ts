import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

// The gate lets a packet worker read and annotate o8.md. A worker reaches only its own lane's
// repository or worktree, may only add notes (comment, reply, suggest, resolve), and cannot hand
// in replacement content. The operator keeps every action on any repository.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-repo-spec-worker-'));
const OPERATOR_TOKEN = 'repo-spec-worker-operator-0123456789';
const LEGACY_WORKER_TOKEN = 'repo-spec-worker-legacy-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(join(dataDir, 'worker-token'), LEGACY_WORKER_TOKEN, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb } = await import('@/lib/db');
const route = await import('@/app/api/repo-spec/route');
const { panelGateMiddleware } = await import('@/middleware');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

// A loopback caller, as Next's bundled server stamps it, through the real gate and then the route.
async function spec(token: string, repoPath: string, action?: string, body?: Record<string, unknown>) {
  const query = new URLSearchParams({ repoPath, ...(action ? { action } : {}) });
  const url = `http://localhost:3001/api/repo-spec?${query}`;
  const init = {
    method: body ? 'POST' : 'GET',
    headers: {
      host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const gate = panelGateMiddleware(new NextRequest(url, init));
  if (gate.headers.get('x-middleware-next') !== '1') return gate;
  return body ? route.POST(new NextRequest(url, init)) : route.GET(new NextRequest(url, init));
}

it('keeps a packet worker to notes on its own lane repository', async () => {
  const repo = join(dataDir, 'repo');
  const worktree = join(dataDir, 'worktree');
  const outside = join(dataDir, 'another-repo');
  for (const dir of [repo, worktree, outside]) mkdirSync(dir);
  writeFileSync(join(worktree, 'o8.md'), '# Spec\n\nOperator prose.\n');
  createLane({ repoPath: repo, worktreePath: worktree, branch: 'fixture-spec', runtime: 'codex', packetId: 'fixture-spec' });
  const worker = mintPacketWorkerToken('fixture-spec');

  // Another repository: refused for reads and notes, and nothing is written there.
  for (const response of [
    await spec(worker, outside),
    await spec(worker, outside, 'comment', { body: 'fixture note elsewhere' }),
  ]) expect(response.status).toBe(403);
  expect(existsSync(join(outside, 'o8.md'))).toBe(false);
  expect((await spec(LEGACY_WORKER_TOKEN, worktree, 'comment', { body: 'fixture legacy note' })).status).toBe(403);

  // Its own worktree: replacement content and operator-only actions are refused.
  expect((await spec(worker, worktree, 'comment', { body: 'fixture note', content: '# Replaced\n' })).status).toBe(403);
  expect((await spec(worker, worktree, 'apply-suggestion', { targetId: 'fixture' })).status).toBe(403);
  expect((await spec(worker, worktree, 'review', {})).status).toBe(403);
  expect(readFileSync(join(worktree, 'o8.md'), 'utf8')).toBe('# Spec\n\nOperator prose.\n');

  // A note on its own worktree, and a read of its lane repository, still work.
  const noted = await spec(worker, worktree, 'comment', { body: 'fixture worker note' });
  expect(noted.status).toBe(200);
  expect(readFileSync(join(worktree, 'o8.md'), 'utf8')).toContain('fixture worker note');
  expect(readFileSync(join(worktree, 'o8.md'), 'utf8')).toContain('Operator prose.');
  expect((await spec(worker, repo)).status).toBe(200);

  // The operator still annotates any repository.
  expect((await spec(OPERATOR_TOKEN, outside, 'comment', { body: 'operator note' })).status).toBe(200);
  expect(readFileSync(join(outside, 'o8.md'), 'utf8')).toContain('operator note');
});
