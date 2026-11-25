/**
 * #2440 — the referee-ordered mobile inbox, through the real path.
 *
 * Real-path doctrine: approvals are seeded through the real approvals store,
 * the setting is written through the operator-defaults store, the key is read
 * from the data-dir key file, the referee call goes over HTTP to the local
 * judgment endpoint fixture, and every assertion reads the payload the real
 * `/api/mobile/inbox` route handler returns. Nothing calls the urgency module
 * directly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-inbox-urgency-'));
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  HOME: process.env.HOME,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
// Runtime discovery reads the home directory's CLI session dirs. Point it at
// the temp dir so the inbox under test holds exactly the seeded approvals.
process.env.HOME = dataDir;

const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { setApprovalRefereeOptionsForTests, startApprovalReferee, waitForApprovalReferee } = await import('@/lib/approvals/referee');
const { closeDb, getSqlite } = await import('@/lib/db');
const { DIFF_QUESTIONS, INBOX_QUESTIONS } = await import('@/lib/judgment/questions');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { invalidateInboxCache } = await import('@/lib/mobile/inbox');
const {
  clearInboxUrgencyCacheForTests,
  inboxUrgencyQuestionId,
  INBOX_URGENCY_ITEMS_PER_CALL,
  INBOX_URGENCY_SURFACE,
  setInboxUrgencyTransportForTests,
  waitForInboxUrgency,
} = await import('@/lib/mobile/inbox-urgency');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const inboxRoute = await import('@/app/api/mobile/inbox/route');

type InboxItem = {
  id: string;
  kind: string;
  urgency?: { score: number; confidence: number; abstain: boolean; receiptId: string | null };
};
type SentBody = {
  questions: Record<string, unknown>;
  state: { items: Array<Record<string, unknown>> };
};

/** Every seeded card's operator-visible text carries this, so one scan proves none of it was sent. */
const WORKER_TEXT = 'ripcord-worker-prose';
const INBOX_URL = 'http://127.0.0.1:47120/api/mobile/inbox?workspaceReview=0';
const LEGEND = Object.fromEntries(INBOX_QUESTIONS.urgency.criteria.map((text, index) => [String(index), text]));

let fixture: JudgmentEndpointFixture;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function readInbox() {
  const startedAt = performance.now();
  const response = await inboxRoute.GET(new NextRequest(INBOX_URL));
  const text = await response.text();
  const elapsedMs = performance.now() - startedAt;
  expect(response.status).toBe(200);
  return { text, elapsedMs, items: (JSON.parse(text) as { items: InboxItem[] }).items };
}

/** Distinct `createdAt` per card, so today's newest-first order is stable. */
async function seedApprovals(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    createApproval({
      source: 'runtime',
      runtime: 'codex',
      agent: 'Codex',
      sessionKey: `codex:urgency-${index}`,
      title: `${WORKER_TEXT} title ${index}`,
      description: `${WORKER_TEXT} description ${index}`,
      summary: `${WORKER_TEXT} summary ${index}`,
      risk: index % 2 === 0 ? 'high' : 'low',
    });
    await sleep(2);
  }
}

function scoreReply(answers: Array<{ itemId: string; score: number; confidence?: number }>) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: Object.fromEntries(answers.map(({ itemId, score, confidence }) => [
        inboxUrgencyQuestionId(itemId),
        {
          type: 'score',
          score,
          confidence: confidence ?? 0.82,
          legend: LEGEND,
          probabilities: { 0: 0.1, 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.3 },
        },
      ])),
      usage: { input_tokens: 240, output_tokens: 60 },
    },
  };
}

const RISK_LEGEND = Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text]));

/** The merge-card referee's reply (#2435), stored on the approval by the real referee. */
function mergeCardRefereeReply(docsOnly: number, risk: number) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        docsOnly: { type: 'noul', noul: docsOnly },
        touchesMiddlewareOrAuth: { type: 'noul', noul: 0.02 },
        containsPlaceholderOrMockData: { type: 'noul', noul: 0.01 },
        addsTests: { type: 'noul', noul: 0.03 },
        scopeCreepBeyondTitle: { type: 'noul', noul: 0.1 },
        testsReachRealEntryPoint: { type: 'noul', noul: 0.02 },
        risk: { type: 'score', score: risk, confidence: 0.9, legend: RISK_LEGEND, probabilities: { 0: 0.8, 1: 0.2, 2: 0, 3: 0, 4: 0 } },
        recommendedAction: { type: 'choice', choice: 'operatorCard', confidence: 0.7, probabilities: { autoApprove: 0.2, operatorCard: 0.7, reject: 0.1 } },
      },
      usage: { input_tokens: 300, output_tokens: 90 },
    },
  };
}

/** The snapshot's build clock is the one value two runs may legitimately disagree on. */
const withoutBuildClock = (text: string) => text.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<clock>"');

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  writeJudgmentFixtureKey(judgmentKeyPath());
});

beforeEach(async () => {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM approval_events').run();
  sqlite.prepare('DELETE FROM approvals').run();
  sqlite.prepare('DELETE FROM judgment_receipts').run();
  clearInboxUrgencyCacheForTests();
  invalidateInboxCache();
  fixture.reset();
  setInboxUrgencyTransportForTests({ endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 5_000 });
  setApprovalRefereeOptionsForTests({ endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 5_000 });
  await updateOperatorDefaults({ judgmentProvider: 'off' });
});

afterAll(async () => {
  setInboxUrgencyTransportForTests(undefined);
  setApprovalRefereeOptionsForTests(undefined);
  await fixture.close();
  closeDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('referee-ordered mobile inbox through the real route', () => {
  it('returns items in score order with the score and receipt attached, from one call that carries no card text', async () => {
    await seedApprovals(4);

    // Today's order, with the setting off: no call, no urgency key.
    const baseline = await readInbox();
    const ids = baseline.items.map((item) => item.id);
    expect(ids).toHaveLength(4);
    expect(fixture.seen).toHaveLength(0);

    const scores = [1, 3.4, 0.2, 2.5];
    fixture.replies.push(scoreReply(ids.map((itemId, index) => ({ itemId, score: scores[index] }))));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

    // The response never waits on the provider: the first poll still shows today's order.
    const cold = await readInbox();
    expect(cold.items.map((item) => item.id)).toEqual(ids);
    expect(cold.items.every((item) => item.urgency === undefined)).toBe(true);

    await waitForInboxUrgency();
    const scored = await readInbox();

    expect(scored.items.map((item) => item.id)).toEqual([ids[1], ids[3], ids[0], ids[2]]);
    expect(scored.items.map((item) => item.urgency?.score)).toEqual([3.4, 2.5, 1, 0.2]);
    expect(scored.items.every((item) => item.urgency?.abstain === false)).toBe(true);

    // One call, one receipt, and the receipt id the phone can open is that receipt.
    expect(fixture.seen).toHaveLength(1);
    const receipts = listJudgmentReceipts({ limit: 100 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: true, surface: INBOX_URGENCY_SURFACE, model: 'jev-1.13.0' });
    expect(new Set(scored.items.map((item) => item.urgency?.receiptId))).toEqual(new Set([receipts[0].id]));

    // The request carried o8-computed facts only — no title, description, or summary.
    const sent = fixture.seen[0].body as unknown as SentBody;
    expect(JSON.stringify(sent)).not.toContain(WORKER_TEXT);
    expect(sent.state.items).toHaveLength(4);
    expect(Object.keys(sent.state.items[0]).sort())
      .toEqual(['ageMinutes', 'id', 'kind', 'laneBlocked', 'laneState', 'riskWord']);
    expect(sent.state.items[0]).toMatchObject({
      kind: 'approval',
      laneState: 'none',
      laneBlocked: false,
      ageMinutes: 0,
    });
    expect(sent.state.items.map((item) => item.riskWord)).toEqual(expect.arrayContaining(['high', 'low']));
  }, 60_000);

  it('scores the inbox under the managed provider value (#2484)', async () => {
    await seedApprovals(2);
    const ids = (await readInbox()).items.map((item) => item.id);
    fixture.replies.push(scoreReply(ids.map((itemId, index) => ({ itemId, score: index }))));
    await updateOperatorDefaults({ judgmentProvider: 'managed' });

    await readInbox();
    await waitForInboxUrgency();
    const scored = await readInbox();

    expect(fixture.seen).toHaveLength(1);
    expect(scored.items.every((item) => typeof item.urgency?.score === 'number')).toBe(true);
    expect(listJudgmentReceipts({ limit: 100 })[0]).toMatchObject({ ok: true, provider: 'managed', surface: INBOX_URGENCY_SURFACE });
  }, 60_000);

  it('asks the locked question text from the questions file, once per item', async () => {
    await seedApprovals(2);
    const baseline = await readInbox();
    const ids = baseline.items.map((item) => item.id);

    fixture.replies.push(scoreReply(ids.map((itemId, index) => ({ itemId, score: index }))));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    await readInbox();
    await waitForInboxUrgency();

    const sent = fixture.seen[0].body as unknown as SentBody;
    expect(Object.keys(sent.questions)).toEqual(ids.map(inboxUrgencyQuestionId));
    for (const question of Object.values(sent.questions)) {
      expect(question).toEqual(INBOX_QUESTIONS.urgency);
      expect((question as { instructions: string }).instructions).toBe(INBOX_QUESTIONS.urgency.instructions);
    }
  }, 60_000);

  it('with the setting off returns the baseline payload byte for byte and makes no request', async () => {
    await seedApprovals(3);
    const baseline = await readInbox();
    const ids = baseline.items.map((item) => item.id);
    expect(baseline.text).not.toContain('"urgency"');
    expect(fixture.seen).toHaveLength(0);

    fixture.replies.push(scoreReply([
      { itemId: ids[0], score: 0.5 },
      { itemId: ids[1], score: 2.5 },
      { itemId: ids[2], score: 1.5 },
    ]));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    await readInbox();
    await waitForInboxUrgency();
    const scored = await readInbox();
    expect(scored.text).toContain('"urgency"');
    expect(scored.items.map((item) => item.id)).toEqual([ids[1], ids[2], ids[0]]);
    const callsWhileOn = fixture.seen.length;
    expect(callsWhileOn).toBeGreaterThan(0);

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await readInbox();

    expect(withoutBuildClock(off.text)).toBe(withoutBuildClock(baseline.text));
    expect(fixture.seen).toHaveLength(callsWhileOn);
  }, 60_000);

  it('keeps an abstaining item and a failed batch in today\'s order without delaying the response', async () => {
    const itemCount = INBOX_URGENCY_ITEMS_PER_CALL + 2;
    await seedApprovals(itemCount);
    const baseline = await readInbox();
    const ids = baseline.items.map((item) => item.id);
    expect(ids).toHaveLength(itemCount);

    // First batch answers; the item at index 3 answers under the abstain floor.
    const scores = [1, 3.5, 0.5, 4, 2, 3, 0.2, 1.5];
    fixture.replies.push(scoreReply(ids.slice(0, INBOX_URGENCY_ITEMS_PER_CALL).map((itemId, index) => ({
      itemId,
      score: scores[index],
      confidence: index === 3 ? 0.3 : 0.8,
    }))));
    // The second batch's reply is held past the client's timeout, so that call errors.
    const held = deferred();
    fixture.replies.push({ status: 200, body: {}, hold: held.promise }, { status: 200, body: {}, hold: held.promise });

    setInboxUrgencyTransportForTests({ endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 300 });
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

    const cold = await readInbox();
    expect(cold.items.map((item) => item.id)).toEqual(ids);
    await waitForInboxUrgency();

    // Two calls, two receipts: the answered batch and the timed-out one.
    expect(fixture.seen).toHaveLength(2);
    const receipts = listJudgmentReceipts({ limit: 100 });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.surface === INBOX_URGENCY_SURFACE)).toBe(true);
    expect(receipts.filter((receipt) => !receipt.ok)).toMatchObject([{ error: { kind: 'timeout' } }]);

    // The next poll re-asks the two unscored items; that call is held open for
    // the rest of the test, so a response that waited on it could not return.
    setInboxUrgencyTransportForTests({ endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 30_000 });
    const scored = await readInbox();
    expect(scored.elapsedMs).toBeLessThan(2_000);

    expect(scored.items.map((item) => item.id)).toEqual([
      ids[1], ids[5], ids[4], ids[7], ids[0], ids[2], ids[6],
      // Rank 0, in today's order: the abstain, then the two the referee never answered.
      ids[3], ids[8], ids[9],
    ]);
    const byId = new Map(scored.items.map((item) => [item.id, item]));
    expect(byId.get(ids[3])!.urgency).toMatchObject({ score: 4, confidence: 0.3, abstain: true });
    expect(byId.get(ids[8])!.urgency).toBeUndefined();
    expect(byId.get(ids[9])!.urgency).toBeUndefined();

    held.release();
    await waitForInboxUrgency();
  }, 60_000);
  it('re-asks a card scored before its merge-card referee facts once they arrive (#2475)', async () => {
    const path = 'docs/guide.md';
    const diffText = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-old line', '+new line'].join('\n');
    const approval = createApproval({
      source: 'test',
      runtime: 'codex',
      agent: 'Codex',
      sessionKey: 'codex:urgency-referee',
      title: `${WORKER_TEXT} merge`,
      description: `${WORKER_TEXT} description`,
      summary: `${WORKER_TEXT} summary`,
      diff: { path: 'multi-file', after: diffText, files: [{ path, status: 'M' as const, patch: '' }] },
      risk: 'low',
    });
    const baseline = await readInbox();
    const [itemId] = baseline.items.map((item) => item.id);
    expect(baseline.items).toHaveLength(1);

    // First poll lands before the referee has answered: the score is asked without its facts.
    fixture.replies.push(scoreReply([{ itemId, score: 1 }]));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    await readInbox();
    await waitForInboxUrgency();
    expect((await readInbox()).items[0].urgency?.score).toBe(1);
    expect(fixture.seen).toHaveLength(1);
    expect((fixture.seen[0].body as unknown as SentBody).state.items[0]).not.toHaveProperty('mergeCardReferee');

    // The real merge-card referee stores its facts on the approval.
    fixture.replies.push(mergeCardRefereeReply(0.97, 0.2));
    startApprovalReferee({ approvalId: approval.id, files: [{ path }], diffText });
    expect((await waitForApprovalReferee(approval.id))?.answers.docsOnly.noul).toBe(0.97);
    expect(getApproval(approval.id)?.referee).toBeDefined();
    expect(fixture.seen).toHaveLength(2);

    // The next poll re-asks that card, now carrying the facts; the one after shows the new score.
    fixture.replies.push(scoreReply([{ itemId, score: 3.5 }]));
    await readInbox();
    await waitForInboxUrgency();
    expect(fixture.seen).toHaveLength(3);
    const reasked = (fixture.seen[2].body as unknown as SentBody).state.items;
    expect(reasked).toHaveLength(1);
    expect(reasked[0].mergeCardReferee).toEqual({ docsOnly: 0.97, risk: 0.2 });
    expect(JSON.stringify(fixture.seen[2].body)).not.toContain(WORKER_TEXT);
    expect((await readInbox()).items[0].urgency?.score).toBe(3.5);
    expect(fixture.seen).toHaveLength(3);

    // Setting off: the baseline bytes, no further request.
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await readInbox();
    expect(withoutBuildClock(off.text)).toBe(withoutBuildClock(baseline.text));
    expect(fixture.seen).toHaveLength(3);
  }, 60_000);
});
