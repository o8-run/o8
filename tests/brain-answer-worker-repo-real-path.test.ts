import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { SseEmit } from '@/lib/cortex/qa/composer';
import type { TypedRow } from '@/lib/cortex/qa/types';

// The gate lets a packet worker ask Brain about its packet. A value lookup greps the repository
// it names and hands the matching lines to the composer. A worker may name only its own lane's
// repository or worktree. The composer is the model boundary: here it echoes the rows it received.
vi.mock('@/lib/cortex/qa/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cortex/qa/composer')>();
  const echo = async (_question: string, _repoPath: string | undefined, rows: TypedRow[], emit: SseEmit) => {
    emit('token', { text: JSON.stringify(rows) });
  };
  return { ...actual, composeClassA: echo, composeClassB: echo };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/haiku-adapter')>(),
  prewarmHaiku: async () => {},
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-answer-worker-'));
const OPERATOR_TOKEN = 'brain-answer-worker-operator-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb } = await import('@/lib/db');
const route = await import('@/app/api/cortex/ask/answer/route');
const { panelGateMiddleware } = await import('@/middleware');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

// A loopback caller, as Next's bundled server stamps it, through the real gate and then the route.
async function ask(token: string, body: Record<string, unknown>) {
  const url = 'http://localhost:3001/api/cortex/ask/answer';
  const init = {
    method: 'POST',
    headers: {
      host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1',
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    },
    body: JSON.stringify({ bypassCache: true, ...body }),
  };
  const gate = panelGateMiddleware(new NextRequest(url, init));
  if (gate.headers.get('x-middleware-next') !== '1') return gate;
  return route.POST(new NextRequest(url, init));
}

it("answers a packet worker's value lookup only from its own lane's repository", async () => {
  const repo = join(dataDir, 'repo');
  const other = join(dataDir, 'other-checkout');
  mkdirSync(repo);
  mkdirSync(other);
  writeFileSync(join(repo, 'settings.txt'), 'FIXTURE_LOOKUP_KEY = fixture-own-value\n');
  writeFileSync(join(other, '.env'), 'FIXTURE_LOOKUP_KEY = fixture-other-checkout-value\n');
  createLane({ repoPath: repo, branch: 'fixture-brain', runtime: 'codex', packetId: 'fixture-brain' });
  const worker = mintPacketWorkerToken('fixture-brain');
  const question = 'What is the value of FIXTURE_LOOKUP_KEY?';

  // Another directory: refused, and none of its lines reach the composer or the caller.
  const elsewhere = await ask(worker, { question, packetId: 'fixture-brain', repoPath: other });
  const elsewhereText = await elsewhere.text();
  expect(elsewhereText).not.toContain('fixture-other-checkout-value');
  expect(elsewhere.status).toBe(403);
  expect(JSON.parse(elsewhereText)).toMatchObject({ error: { code: 'worker_packet_mismatch' } });

  // Its own lane's repository, named or defaulted from the packet, still answers.
  for (const body of [{ repoPath: repo }, {}]) {
    const own = await ask(worker, { question, packetId: 'fixture-brain', ...body });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { answer: string }).answer).toContain('fixture-own-value');
  }

  // The operator still asks about any repository.
  const operator = await ask(OPERATOR_TOKEN, { question, repoPath: other });
  expect(operator.status).toBe(200);
  expect(((await operator.json()) as { answer: string }).answer).toContain('fixture-other-checkout-value');
});
