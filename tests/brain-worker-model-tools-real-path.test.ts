import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A Brain ask can reach a model command-line tool. A packet worker's question runs only on a model
// with no tools: Claude starts with none, Codex is not launched, and with neither the worker gets the
// retrieved sources. The operator's asks keep their routes. Fake `claude` and `codex` executables
// record the arguments of every turn they serve; the HTTP tiers have no route in this fixture.
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/openrouter-adapter')>(),
  callOpenRouter: async () => { throw new Error('no inference route in this fixture'); },
}));
vi.mock('@/lib/providers/key-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/providers/key-store')>(),
  resolveProviderKey: () => null,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-worker-tools-'));
const repo = join(dataDir, 'repo');
const turnLog = join(dataDir, 'turns.jsonl');
const OPERATOR_TOKEN = 'brain-worker-tools-operator-0123456789';
mkdirSync(repo);
writeFileSync(join(repo, 'settings.txt'), 'FIXTURE_TOOL_KEY = fixture-own-value\n');
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');

function fakeCli(name: string, body: string): string {
  const path = join(dataDir, name);
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const served = () => appendFileSync(${JSON.stringify(turnLog)}, JSON.stringify({ cli: ${JSON.stringify(name)}, args }) + '\\n');
${body}
`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLAUDE_CODE_BIN = fakeCli('claude', `
if (args.includes('--version')) { process.stdout.write('2.1.319 (Claude Code)\\n'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  served();
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture Claude answer' }) + '\\n');
});`);
process.env.O8_CODEX_BIN = fakeCli('codex', `
process.stdin.resume();
process.stdin.on('end', () => {
  served();
  writeFileSync(args[args.indexOf('--output-last-message') + 1], 'fixture Codex answer');
});`);
delete process.env.O8_EVAL_MODE;

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
const { resetWarmReplPool } = await import('@/lib/claude-code/warm-repl-pool');
const { closeDb } = await import('@/lib/db');
const route = await import('@/app/api/cortex/ask/answer/route');
const { panelGateMiddleware } = await import('@/middleware');

createLane({ repoPath: repo, branch: 'fixture-tools', runtime: 'codex', packetId: 'fixture-tools' });
const WORKER_TOKEN = mintPacketWorkerToken('fixture-tools');
const question = 'What is the value of FIXTURE_TOOL_KEY?';

afterAll(() => {
  resetWarmReplPool();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWarmReplPool();
  invalidateAnswerCache();
  rmSync(turnLog, { force: true });
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
    body: JSON.stringify({ question, ...body }),
  };
  const gate = panelGateMiddleware(new NextRequest(url, init));
  expect(gate.headers.get('x-middleware-next')).toBe('1');
  const res = await route.POST(new NextRequest(url, init));
  expect(res.status).toBe(200);
  return await res.json() as { answer: string; citations: unknown[] };
}

function turns(): Array<{ cli: 'claude' | 'codex'; args: string[] }> {
  if (!existsSync(turnLog)) return [];
  return readFileSync(turnLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function withoutTools(args: string[]): boolean {
  const at = args.indexOf('--tools');
  return at >= 0 && args[at + 1] === '';
}

it("runs a packet worker's ask on Claude with no tools and leaves the operator's tools in place", async () => {
  await updateOperatorDefaults({
    brainRoutingMode: 'subscription', brainUseClaudeCli: true, brainWarmupEnabled: true,
    classAComposer: 'auto', judgmentProvider: 'off',
  });

  expect((await ask(OPERATOR_TOKEN, { repoPath: repo, bypassCache: true })).answer).toContain('fixture Claude answer');
  expect(turns().map(({ cli, args }) => [cli, withoutTools(args)])).toEqual([['claude', false]]);

  // The operator's turn left a warm process with tools behind; the worker's turn must not take it.
  rmSync(turnLog);
  expect((await ask(WORKER_TOKEN, { packetId: 'fixture-tools', bypassCache: true })).answer).toContain('fixture Claude answer');
  expect(turns().map(({ cli, args }) => [cli, withoutTools(args)])).toEqual([['claude', true]]);

  // Nor does the operator take the worker's tool-less process.
  rmSync(turnLog);
  await ask(OPERATOR_TOKEN, { repoPath: repo, bypassCache: true });
  expect(turns().map(({ cli, args }) => [cli, withoutTools(args)])).toEqual([['claude', false]]);

  // A question that is not a value lookup is classified by a model too; that call has no tools either.
  rmSync(turnLog);
  await ask(WORKER_TOKEN, { question: 'How should a packet hand off its review?', packetId: 'fixture-tools', bypassCache: true });
  expect(turns().length).toBeGreaterThan(1);
  expect(turns().filter(({ cli, args }) => cli !== 'claude' || !withoutTools(args))).toEqual([]);
}, 30_000);

it("never launches Codex for a packet worker and answers it from the retrieved sources", async () => {
  await updateOperatorDefaults({
    brainRoutingMode: 'subscription', brainUseClaudeCli: false, brainWarmupEnabled: true,
    classAComposer: 'auto', judgmentProvider: 'off',
  });

  // The operator's ask runs on Codex as before, and its answer is cached.
  expect((await ask(OPERATOR_TOKEN, { repoPath: repo })).answer).toContain('fixture Codex answer');
  expect(turns().map(({ cli }) => cli)).toEqual(['codex']);

  // The worker's ask, fresh and then through the cache, launches no model and returns the sources.
  rmSync(turnLog);
  for (const bypassCache of [true, false]) {
    const answer = await ask(WORKER_TOKEN, { packetId: 'fixture-tools', bypassCache });
    expect(answer.answer).not.toContain('fixture Codex answer');
    expect(answer.answer).toContain('fixture-own-value');
    expect(answer.citations.length).toBeGreaterThan(0);
  }
  expect(turns()).toEqual([]);

  // The operator still gets its own cached Codex answer.
  expect((await ask(OPERATOR_TOKEN, { repoPath: repo })).answer).toContain('fixture Codex answer');
  expect(turns()).toEqual([]);
}, 30_000);
