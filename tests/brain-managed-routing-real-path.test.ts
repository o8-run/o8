/**
 * Managed Brain routing through the public answer route.
 *
 * These cases persist entitlement and operator settings, index source rows,
 * then exercise the actual ask pipeline. Direct-key values are deliberate
 * decoys: a managed request must never send them to a provider.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-managed-route-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-brain-managed-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_PROXY_URL = 'http://managed.test';
process.env.O8_HYBRID_SCORER = '1';

const cli = vi.hoisted(() => ({
  codex: vi.fn(async () => JSON.stringify({ class: 'A', bm25_variants: ['maple managed'] })),
  haiku: vi.fn(async () => { throw new Error('CLI must not run'); }),
  sonnet: vi.fn(async () => { throw new Error('CLI must not run'); }),
  prewarmHaiku: vi.fn(async () => undefined),
  prewarmSonnet: vi.fn(async () => undefined),
}));

vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({
  CODEX_DEFAULT_MODEL: 'gpt-5.5',
  callCodex: cli.codex,
}));
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({
  callHaiku: cli.haiku,
  prewarmHaiku: cli.prewarmHaiku,
}));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({
  callSonnet: cli.sonnet,
  prewarmSonnetCli: cli.prewarmSonnet,
}));

const { getSqlite } = await import('@/lib/db');
const { ingestRepoSpecs } = await import('@/lib/cortex/spec-ingest');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getEntitlementPath } = await import('@/lib/entitlement/store');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');
const { invalidateAnswerCache, runAskPipeline } = await import('@/lib/cortex/qa/ask');
const { classifyQuestion, resetClassifierCache } = await import('@/lib/cortex/qa/classifier');
const { resetOpenRouterCircuit } = await import('@/lib/cortex/qa/llm/openrouter-adapter');
const { recallRows, resetRecallCacheForTests } = await import('@/lib/cortex/qa/recall');
const { retrieveAll, unionMerge } = await import('@/lib/cortex/qa/retrieve');
const answerRoute = await import('@/app/api/cortex/ask/answer/route');

const PLAN_TOKEN = 'header.payload.signature';
const now = new Date().toISOString();
const seen: Array<{ url: string; authorization: string | null; body: unknown }> = [];
let inferenceStatus = 200;
let refereeStatus = 200;
let refereeConfidence = 0.96;
let refereeChoice: 'classA' | 'classB' = 'classA';

function writeEntitlement(plan: 'pro' | 'founder' | 'free', token = PLAN_TOKEN): void {
  writeFileSync(getEntitlementPath(), `${JSON.stringify({ plan, status: 'active', licenseKey: token })}\n`);
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function managedFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  seen.push({ url: target, authorization: headers.get('authorization'), body });
  if (!target.startsWith('http://managed.test/')) {
    return Promise.resolve(response(599, { error: `direct provider decoy invoked: ${target}` }));
  }
  if (target.endsWith('/v1/judgment')) {
    if (refereeStatus !== 200) {
      return Promise.resolve(response(refereeStatus, { error: 'daily cap reached', kind: 'judgment' }));
    }
    const other = refereeChoice === 'classA' ? 'classB' : 'classA';
    return Promise.resolve(response(200, {
      model: 'jev-managed-fixture',
      answers: {
        questionClass: {
          type: 'choice', choice: refereeChoice, confidence: refereeConfidence,
          probabilities: { [refereeChoice]: refereeConfidence, [other]: 1 - refereeConfidence },
        },
      },
      usage: { input_tokens: 8, output_tokens: 2 },
    }));
  }
  if (target.endsWith('/v1/embeddings')) {
    return Promise.resolve(response(200, { embedding: { values: [1, 0, 0] } }));
  }
  if (target.endsWith('/v1/inference')) {
    if (inferenceStatus !== 200) return Promise.resolve(response(inferenceStatus, { error: 'daily cap reached' }));
    const prompt = String((body as { messages?: Array<{ content?: unknown }> } | null)?.messages?.[0]?.content ?? '');
    if (prompt.includes('Classify the engineering question')) {
      return Promise.resolve(response(200, {
        choices: [{ message: { content: JSON.stringify({ class: 'A', bm25_variants: ['managed maple'] }) } }],
      }));
    }
    return Promise.resolve(response(200, {
      choices: [{ message: { content: 'Managed Maple answer.' } }],
      model: 'managed-fixture',
      usage: { prompt_tokens: 5, completion_tokens: 4, total_cost: 0 },
    }));
  }
  return Promise.resolve(response(404, { error: 'unknown managed fixture path' }));
}

async function ask(question: string, bypassCache = false) {
  const request = new NextRequest('http://test.local/api/cortex/ask/answer', {
    method: 'POST',
    body: JSON.stringify({ question, repoPath, bypassCache }),
  });
  const result = await answerRoute.POST(request);
  return { status: result.status, body: await result.json() as Record<string, unknown> };
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'managed-brain-route', name: 'Managed Brain Route', repoPaths: [repoPath], createdAt: now }],
    activeProjectId: 'managed-brain-route',
  }));
  writeFileSync(join(repoPath, 'CLAUDE.md'), `# Managed Maple\n\n## Routing\nManaged maple routing preserves the single payer rule for Brain answers and keeps source evidence available.\n`);
  await ingestRepoSpecs(repoPath);
  mkdirSync(join(dataDir, 'directives'), { recursive: true });
  writeFileSync(join(dataDir, 'directives', 'managed-maple-high-priority.md'), `---
id: managed-maple-high-priority
title: Managed maple high priority rule
scope: global
priority: 8
---
Managed maple routing must preserve a single payer.`);
  getSqlite().prepare(
    'INSERT INTO directives_fts(directive_id, title, body) VALUES (?, ?, ?)',
  ).run('managed-maple-high-priority', 'Managed maple high priority rule', 'Managed maple routing must preserve a single payer.');
  // Recall requires the outcome to belong to the selected project.
  getSqlite().prepare(`
    INSERT INTO session_outcomes (
      id, project_id, repo_path, runtime, outcome, summary, plan_text,
      retry_history_json, patterns_json, conflict_zones_json, changed_files_json,
      started_at, completed_at, valid_from
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?)
  `).run('managed-maple-outcome', 'managed-brain-route', repoPath, 'codex', 'completed', 'Managed maple routing completed with source evidence.', 'Use managed maple routing.', now, now, now);
  getSqlite().prepare(`
    INSERT INTO facts (
      id, kind, content, source_kind, source_id, source_excerpt,
      repo_path, confidence, fingerprint, extracted_by, source_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('managed-maple-fact', 'decision', 'Managed maple routing uses one payer.', 'test', 'managed-maple', 'Managed maple routing uses one payer.', repoPath, 0.9, 'managed-maple-fingerprint', 'test', 1);
});

beforeEach(async () => {
  seen.length = 0;
  inferenceStatus = 200;
  refereeStatus = 200;
  refereeConfidence = 0.96;
  refereeChoice = 'classA';
  cli.codex.mockClear();
  cli.haiku.mockClear();
  cli.sonnet.mockClear();
  cli.prewarmHaiku.mockClear();
  cli.prewarmSonnet.mockClear();
  resetOpenRouterCircuit();
  resetClassifierCache();
  resetRecallCacheForTests();
  invalidateAnswerCache();
  process.env.O8_BYOK_REQUIRED = '1';
  process.env.GOOGLE_AI_API_KEY = 'google-direct-key-decoy';
  process.env.OPENAI_API_KEY = 'openai-direct-key-decoy';
  writeEntitlement('pro');
  await updateOperatorDefaults({
    brainRoutingMode: 'auto',
    brainUseClaudeCli: true,
    judgmentProvider: 'typesafe',
  });
  vi.stubGlobal('fetch', managedFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.O8_BYOK_REQUIRED;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.O8_HYBRID_SCORER;
  delete process.env.O8_PROXY_URL;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('managed Brain answer route', () => {
  it('uses managed judgment, inference, and cache embeddings for Pro and founder without direct-key or CLI fallbacks', async () => {
    const pro = await ask('What does managed maple routing require?');
    expect(pro.status).toBe(200);
    expect(pro.body).toMatchObject({ ok: true, answer: 'Managed Maple answer.', class: 'A' });
    expect(pro.body.sourcesConsidered).toEqual(expect.any(Number));
    expect(pro.body.sourcesConsidered as number).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inferenceCalls = seen.filter((entry) => entry.url.endsWith('/v1/inference'));
    expect(seen.some((entry) => entry.url.endsWith('/v1/judgment'))).toBe(true);
    expect(seen.some((entry) => entry.url.endsWith('/v1/embeddings'))).toBe(true);
    expect(inferenceCalls).toHaveLength(1);
    expect(inferenceCalls[0].authorization).toBe(`Bearer ${PLAN_TOKEN}`);
    expect(seen.every((entry) => entry.url.startsWith('http://managed.test/'))).toBe(true);
    expect(cli.codex).not.toHaveBeenCalled();
    expect(cli.haiku).not.toHaveBeenCalled();
    expect(cli.sonnet).not.toHaveBeenCalled();
    expect(cli.prewarmHaiku).not.toHaveBeenCalled();
    expect(cli.prewarmSonnet).not.toHaveBeenCalled();

    const cacheHit = await ask('What does managed maple routing require?');
    expect(cacheHit.body).toMatchObject({ ok: true, cacheHit: 'exact' });
    expect(seen.filter((entry) => entry.url.endsWith('/v1/inference'))).toHaveLength(1);

    writeEntitlement('founder', 'founder.payload.signature');
    invalidateAnswerCache();
    resetClassifierCache();
    const founder = await ask('What does founder maple routing require?');
    expect(founder.status).toBe(200);
    expect(seen.some((entry) => entry.authorization === 'Bearer founder.payload.signature')).toBe(true);
  });

  it('does not cache a managed cap failure and recovers through managed inference only', async () => {
    inferenceStatus = 402;
    const capped = await ask('What is the managed maple cap recovery rule?');
    expect(capped.status).toBe(500);
    expect(capped.body).toMatchObject({ ok: false, code: 'managed_brain_unavailable' });
    expect(cli.codex).not.toHaveBeenCalled();
    expect(listRoleRoutingReceipts({ repoPath, limit: 10 }).some((receipt) => (
      receipt.status === 'failed' && receipt.effective === null
    ))).toBe(true);

    inferenceStatus = 200;
    const recovered = await ask('What is the managed maple cap recovery rule?');
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ ok: true, cacheHit: null, answer: 'Managed Maple answer.' });
    expect(seen.filter((entry) => entry.url.endsWith('/v1/inference'))).toHaveLength(2);
    expect(seen.every((entry) => entry.url.startsWith('http://managed.test/'))).toBe(true);
  });

  it('keeps Class B contradiction handling deterministic when direct provider keys are present', async () => {
    refereeChoice = 'classB';
    const question = 'Explain the completed managed maple routing outcome.';
    const classification = await classifyQuestion(question);
    expect(classification).toMatchObject({ class: 'B', classifier: 'referee' });
    const topRows = unionMerge(await retrieveAll({
      question,
      repoPath,
      projectId: 'managed-brain-route',
      bm25Variants: classification.bm25Variants,
      questionClass: classification.class,
    }), { questionClass: 'B' });
    expect(topRows).toContainEqual(expect.objectContaining({
      citation: expect.objectContaining({ kind: 'directive', rowId: 'managed-maple-high-priority' }),
      fields: expect.objectContaining({ priority: 8 }),
    }));
    expect(topRows).toContainEqual(expect.objectContaining({
      citation: expect.objectContaining({ kind: 'outcome', rowId: 'managed-maple-outcome' }),
      fields: expect.objectContaining({ outcome: 'completed' }),
    }));
    const frames: Array<{ name: string; payload: unknown }> = [];
    await runAskPipeline(question, repoPath, (name, payload) => {
      frames.push({ name, payload });
    }, true);

    expect(frames.some((frame) => frame.name === 'done')).toBe(true);
    expect(frames).toContainEqual(expect.objectContaining({
      name: 'contradiction',
      payload: expect.objectContaining({ directiveId: 'managed-maple-high-priority', outcomeId: 'managed-maple-outcome' }),
    }));
    expect(seen.every((entry) => entry.url.startsWith('http://managed.test/'))).toBe(true);
    expect(cli.prewarmHaiku).not.toHaveBeenCalled();
    expect(cli.prewarmSonnet).not.toHaveBeenCalled();
  });

  it('fails closed when the entitled plan has no usable token', async () => {
    writeEntitlement('pro', 'not-a-token');
    const result = await ask('What happens when managed maple has no token?');

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ ok: false, code: 'managed_brain_unavailable' });
    expect(seen).toHaveLength(0);
    expect(cli.codex).not.toHaveBeenCalled();
    expect(cli.prewarmHaiku).not.toHaveBeenCalled();
  });

  it('keeps Palette Recall on managed inference after a managed 402', async () => {
    inferenceStatus = 402;
    const recalled = await recallRows('managed maple palette recall', repoPath, 'managed-brain-route');

    expect(recalled.rows).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://managed.test/v1/inference');
    expect(seen[0].authorization).toBe(`Bearer ${PLAN_TOKEN}`);
  });

  it.each([
    ['cap', 402, 0.96],
    ['low confidence', 200, 0.2],
  ])('keeps managed inference as the only classifier fallback after referee %s', async (_label, status, confidence) => {
    refereeStatus = status;
    refereeConfidence = confidence;
    const result = await ask(`What is the managed maple referee ${_label} rule?`);

    expect(result.status).toBe(200);
    expect(seen.filter((entry) => entry.url.endsWith('/v1/inference'))).toHaveLength(2);
    expect(seen.every((entry) => entry.url.startsWith('http://managed.test/'))).toBe(true);
    expect(cli.codex).not.toHaveBeenCalled();
    expect(cli.prewarmHaiku).not.toHaveBeenCalled();
  });

  it('keeps Free auto legacy while explicit subscription remains an opt-in for Pro', async () => {
    writeEntitlement('free');
    await updateOperatorDefaults({ brainRoutingMode: 'auto', judgmentProvider: 'off', brainUseClaudeCli: false });
    vi.stubGlobal('fetch', vi.fn(async () => response(599, { error: 'no managed route for free control' })));
    cli.codex.mockImplementationOnce(async () => JSON.stringify({ class: 'A', bm25_variants: ['maple free'] }))
      .mockImplementationOnce(async () => 'Subscription control answer.');

    const result = await ask('What is the free maple control path?', true);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, answer: 'Subscription control answer.' });
    expect(cli.codex).toHaveBeenCalledTimes(2);

    writeEntitlement('pro');
    resetClassifierCache();
    invalidateAnswerCache();
    cli.codex.mockReset()
      .mockResolvedValueOnce(JSON.stringify({ class: 'A', bm25_variants: ['maple subscription'] }))
      .mockResolvedValueOnce('Pro subscription control answer.');
    await updateOperatorDefaults({ brainRoutingMode: 'subscription', judgmentProvider: 'off', brainUseClaudeCli: false });
    const proSubscription = await ask('What is the Pro subscription control path?', true);
    expect(proSubscription.body).toMatchObject({ ok: true, answer: 'Pro subscription control answer.' });
    expect(cli.codex).toHaveBeenCalledTimes(2);
  });
});
