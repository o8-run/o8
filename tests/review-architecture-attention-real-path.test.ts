/**
 * #2577 — typed advisory ranking through the real Review routes and judgment client.
 *
 * The deterministic delta is fetched first, then the attention route rebuilds and
 * scopes that evidence before making one HTTP call to the local provider fixture.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-architecture-attention-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const operatorBearer = 'architecture-attention-operator-bearer-0123456789';
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorBearer}\n`, 'utf8');

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CODEX_HOME = dataDir;

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', windowsHide: true }).trim();
}

function write(relativePath: string, content: string) {
  const target = path.join(repoPath, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'architecture-attention@example.test']);
git(['config', 'user.name', 'Architecture Attention Test']);
write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
write('src/core.ts', 'export const core = 1;\n');
write('src/feature.ts', "import { core } from '@/core';\nexport const feature = core;\n");
git(['add', '.']);
git(['commit', '-qm', 'test: seed attention fixture']);
write('src/next-core.ts', 'export const nextCore = 2;\n');
write('src/feature.ts', "import { nextCore } from '@/next-core';\nexport const feature = nextCore;\n");

const { closeDb, getSqlite } = await import('@/lib/db');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const {
  ARCHITECTURE_ATTENTION_SURFACE,
  setArchitectureAttentionTransportForTests,
} = await import('@/lib/review/architecture-attention');
const deltaRoute = await import('@/app/api/review/architecture-delta/route');
const attentionRoute = await import('@/app/api/review/architecture-attention/route');

let fixture: JudgmentEndpointFixture;

function routeUrl(name: string) {
  return `http://localhost:3001/api/review/${name}?workspace=${encodeURIComponent(repoPath)}`;
}

function routeRequest(name: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(routeUrl(name), {
    ...init,
    headers: {
      authorization: `Bearer ${operatorBearer}`,
      host: 'localhost:3001',
      ...init.headers,
    },
  });
}

function fixtureReply() {
  const answers = Object.fromEntries([0, 1].flatMap((index) => [
    [`attention_${index}`, {
      type: 'score',
      score: index === 0 ? 2 : 1,
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
      confidence: 0.8,
    }],
    [`lens_${index}`, {
      type: 'choice',
      choice: index === 0 ? 'interface_contract' : 'state_persistence',
      probabilities: { interface_contract: 0.8, state_persistence: 0.2 },
      confidence: 0.8,
    }],
  ]));
  return {
    status: 200,
    body: { model: 'jev-1.13.0', answers, usage: { input_tokens: 120, output_tokens: 32 } },
  };
}

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  writeJudgmentFixtureKey(judgmentKeyPath());
  setArchitectureAttentionTransportForTests({
    endpoint: fixture.endpoint,
    timeoutMs: 5_000,
    maxAttempts: 1,
    retryBaseMs: 1,
  });
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  setArchitectureAttentionTransportForTests(undefined);
  await fixture.close();
  closeDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('architecture attention Review entry point', () => {
  it('uses one typed call with scoped topology facts, persists a receipt, and fails open when disabled', async () => {
    getSqlite().prepare('DELETE FROM judgment_receipts').run();
    fixture.reset();
    fixture.replies.push(fixtureReply());

    const deltaResponse = await deltaRoute.GET(routeRequest('architecture-delta'));
    const delta = await deltaResponse.json() as { analysisId: string };
    expect(deltaResponse.status).toBe(200);
    expect(delta.analysisId).toMatch(/^[a-f0-9]{24}$/);

    const attentionResponse = await attentionRoute.POST(routeRequest('architecture-attention', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedAnalysisId: delta.analysisId,
        scopePaths: ['src/feature.ts', 'src/next-core.ts'],
      }),
    }));
    const attention = await attentionResponse.json();

    expect(attentionResponse.status).toBe(200);
    expect(attention).toMatchObject({ ok: true, status: 'ready', model: 'jev-1.13.0' });
    expect(attention.items).toHaveLength(2);
    expect(fixture.seen).toHaveLength(1);
    const sent = fixture.seen[0].body as {
      state: { modules: Array<Record<string, unknown>> };
      questions: Record<string, unknown>;
    };
    expect(sent.state.modules).toHaveLength(2);
    expect(Object.keys(sent.questions)).toHaveLength(4);
    expect((sent.questions.attention_0 as { instructions: string }).instructions).toContain('state.modules[0]');
    expect((sent.questions.lens_1 as { instructions: string }).instructions).toContain('state.modules[1]');
    expect(JSON.stringify(sent)).not.toContain("export const feature");
    expect(JSON.stringify(sent)).not.toContain("import { nextCore }");

    const receipts = listJudgmentReceipts({ limit: 10 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: true, surface: ARCHITECTURE_ATTENTION_SURFACE });

    fixture.reset();
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const disabledResponse = await attentionRoute.POST(routeRequest('architecture-attention', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedAnalysisId: delta.analysisId, scopePaths: ['src/feature.ts'] }),
    }));
    await expect(disabledResponse.json()).resolves.toMatchObject({ status: 'disabled', items: [] });
    expect(fixture.seen).toHaveLength(0);
  });
});
