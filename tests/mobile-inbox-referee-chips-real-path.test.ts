/**
 * #2439 — the docs-only approve chip on phone inbox cards, through the real path.
 *
 * Real-path doctrine: approvals are seeded through the real approvals store,
 * their referee facts are written by the real referee (`startApprovalReferee`)
 * over HTTP to the local judgment endpoint fixture, the setting is written
 * through the operator-defaults store, and every assertion reads what the real
 * `/api/mobile/inbox` and `/api/panel/approvals` route handlers return or
 * persist. Nothing calls the chip module directly.
 *
 * The approve tests use the only shape that earns a chip: a lane-merge card
 * created by `createLaneActionApproval` on a real git lane, whose referee ran
 * at creation. The phone approves every card through `/api/panel/approvals`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-inbox-chips-'));
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  HOME: process.env.HOME,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};
const operatorToken = 'operator-inbox-chips-2439-0123456789';
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
// Runtime discovery reads the home directory's CLI session dirs. Point it at
// the temp dir so the inbox under test holds exactly the seeded approvals.
process.env.HOME = dataDir;

// The approvals route publishes over WS on success; stub the publisher only.
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const background = vi.hoisted(() => ({ prunes: [] as Promise<unknown>[] }));
vi.mock('@/lib/lane/successful-merge-worktree-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/successful-merge-worktree-cleanup')>();
  return {
    ...actual,
    settleSuccessfulMergeWorktreeCleanup: async (input: Parameters<typeof actual.settleSuccessfulMergeWorktreeCleanup>[0]) => {
      // Keep merge and prune real, but retain the detached writer for teardown.
      const prune = vi.spyOn(input.manager, 'prune');
      try {
        return await actual.settleSuccessfulMergeWorktreeCleanup(input);
      } finally {
        for (const result of prune.mock.results) {
          if (result.type === 'return') background.prunes.push(result.value);
        }
        prune.mockRestore();
      }
    },
  };
});

// Record every lane command the approvals route forwards, then run the real one.
const laneDispatch = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/lane/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/commands')>();
  return {
    ...actual,
    dispatch: vi.fn(async (command: Parameters<typeof actual.dispatch>[0]) => {
      laneDispatch.calls.push({ ...command } as Record<string, unknown>);
      if ('laneId' in command && typeof command.laneId === 'string' && command.laneId.startsWith('route-parity-')) {
        return { ok: true, laneId: command.laneId, note: 'Route parity merge completed.' };
      }
      return actual.dispatch(command);
    }),
  };
});

const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { setApprovalRefereeOptionsForTests, startApprovalReferee, waitForApprovalReferee } = await import('@/lib/approvals/referee');
const { closeDb, getSqlite } = await import('@/lib/db');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { invalidateInboxCache } = await import('@/lib/mobile/inbox');
const { clearInboxUrgencyCacheForTests, setInboxUrgencyTransportForTests, waitForInboxUrgency } = await import('@/lib/mobile/inbox-urgency');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const inboxRoute = await import('@/app/api/mobile/inbox/route');
const approvalsRoute = await import('@/app/api/panel/approvals/route');
const mobileActionRoute = await import('@/app/api/mobile/action/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');

type InboxItem = {
  id: string;
  approvalId?: string;
  refereeChips?: Array<{ kind: string; probability: number; receiptId: string | null }>;
};

const INBOX_URL = 'http://127.0.0.1:47120/api/mobile/inbox?workspaceReview=0';
const RISK_LEGEND = Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text]));

let fixture: JudgmentEndpointFixture;
let seq = 0;
const tempDirs: string[] = [];

function diffFor(paths: string[]): string {
  return paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
  ].join('\n')).join('\n');
}

function refereeReply(docsOnly: number) {
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
        risk: { type: 'score', score: 0.2, confidence: 0.9, legend: RISK_LEGEND, probabilities: { 0: 0.8, 1: 0.2, 2: 0, 3: 0, 4: 0 } },
        recommendedAction: { type: 'choice', choice: 'operatorCard', confidence: 0.7, probabilities: { autoApprove: 0.2, operatorCard: 0.7, reject: 0.1 } },
      },
      usage: { input_tokens: 300, output_tokens: 90 },
    },
  };
}

/** A pending merge card whose diff touches `paths`; with `docsOnly`, the real referee stores its facts. */
async function seedCard(tag: string, paths: string[], docsOnly?: number) {
  seq += 1;
  const rawDiff = diffFor(paths);
  const approval = createApproval({
    source: 'test',
    runtime: 'codex',
    agent: 'Codex',
    sessionKey: `codex:chips-${tag}-${seq}`,
    title: `Merge ${tag}`,
    description: `Approve and merge ${tag}.`,
    summary: `merge-${tag}-${seq}`,
    diff: { path: 'multi-file', after: rawDiff, files: paths.map((path) => ({ path, status: 'M' as const, patch: '' })) },
    risk: 'low',
  });
  if (docsOnly !== undefined) {
    fixture.replies.push(refereeReply(docsOnly));
    startApprovalReferee({ approvalId: approval.id, files: paths.map((path) => ({ path })), diffText: rawDiff });
    const stored = await waitForApprovalReferee(approval.id);
    expect(stored?.answers.docsOnly.noul).toBe(docsOnly);
  }
  await new Promise((resolve) => { setTimeout(resolve, 2); });
  return approval;
}

async function readInbox() {
  invalidateInboxCache();
  const response = await inboxRoute.GET(new NextRequest(INBOX_URL));
  const text = await response.text();
  expect(response.status).toBe(200);
  return { text, items: (JSON.parse(text) as { items: InboxItem[] }).items };
}

/** What the phone sends for every card's Approve (mobile-approvals-client `handleResolve`). */
function approveRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/panel/approvals', {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mobileApproveRequest(sessionKey: string, approvalId: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/mobile/action', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', sessionKey, approvalId }),
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

/** A lane whose branch changes only docs, in its own repo with an origin. */
function makeDocsLane(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const repoDir = join(root, 'operator');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repoDir], { stdio: 'pipe' });
  git(repoDir, ['checkout', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repoDir, 'README.md'), '# Base\n');
  commitAll(repoDir, 'base');
  git(repoDir, ['push', '-u', 'origin', 'main']);
  const repo = realpathSync(repoDir);
  git(repo, ['checkout', '-b', `inline/${name}`]);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'notes.md'), '# Notes\n\nworker\n');
  writeFileSync(join(repo, 'README.md'), '# Base\n\nMore words.\n');
  commitAll(repo, 'docs change');
  return createLane({
    repoPath: repo,
    worktreePath: repo,
    branch: `inline/${name}`,
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: `codex:${name}`,
  });
}

/** The real lane-merge card, with a strategy on its continuation; its referee runs at creation. */
async function createDocsMergeCard(name: string, docsOnly: number) {
  const lane = makeDocsLane(name);
  fixture.replies.push(refereeReply(docsOnly));
  const result = await createLaneActionApproval(lane, 'system', {
    verb: 'merge',
    commitMessage: 'docs: notes',
    title: 'Merge blocked (base moved)',
    description: 'The final fast-forward failed.',
    summary: 'Fast-forward failed',
    risk: 'low',
    policyRuleId: 'fast_forward_failure_escalation',
    note: 'Approval required.',
    strategy: 'theirs',
  });
  const approvalId = result.approvalId!;
  expect((await waitForApprovalReferee(approvalId))?.answers.docsOnly.noul).toBe(docsOnly);
  const approval = getApproval(approvalId)!;
  expect(approval.continuation).toMatchObject({ kind: 'lane', laneId: lane.id, verb: 'merge', strategy: 'theirs' });
  return { lane, approval };
}

function eventRows(approvalId: string) {
  return getSqlite()
    .prepare("SELECT event_type, actor, note, details_json FROM approval_events WHERE approval_id = ? AND event_type = 'approved' ORDER BY timestamp")
    .all(approvalId) as Array<{ event_type: string; actor: string; note: string | null; details_json: string }>;
}

const withoutBuildClock = (text: string) => text.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<clock>"');

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  await updateOperatorDefaults({ storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
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
  const transport = { endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 5_000 };
  setApprovalRefereeOptionsForTests(transport);
  // Urgency scoring also runs while the setting is on; its calls hit the
  // exhausted fixture and fail, which leaves every item unscored.
  setInboxUrgencyTransportForTests(transport);
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  await waitForInboxUrgency();
  expect(background.prunes.length).toBeGreaterThan(0);
  await Promise.all(background.prunes);
  setApprovalRefereeOptionsForTests(undefined);
  setInboxUrgencyTransportForTests(undefined);
  await fixture.close();
  closeDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('docs-only chip on phone inbox cards through the real inbox route', () => {
  it('serialises the chip only for an all-docs diff whose stored answer clears the threshold', async () => {
    const docs = await seedCard('docs', ['README.md', 'docs/guide.md'], 0.97);
    const mixed = await seedCard('mixed', ['README.md', 'src/app.ts'], 0.97);
    const below = await seedCard('below', ['docs/notes.md'], 0.85);
    const noFacts = await seedCard('nofacts', ['docs/other.md']);

    const { items } = await readInbox();
    await waitForInboxUrgency();
    const byApproval = new Map(items.map((item) => [item.approvalId, item]));
    const receiptId = getApproval(docs.id)?.referee?.receiptId;
    expect(receiptId).toBeTruthy();

    expect(byApproval.get(docs.id)?.refereeChips).toEqual([{ kind: 'docs-only', probability: 0.97, receiptId }]);
    expect(byApproval.get(mixed.id)).toBeDefined();
    expect(byApproval.get(mixed.id)).not.toHaveProperty('refereeChips');
    expect(byApproval.get(below.id)).not.toHaveProperty('refereeChips');
    expect(byApproval.get(noFacts.id)).not.toHaveProperty('refereeChips');
  }, 60_000);

  it('serialises the chip under the managed provider value (#2484)', async () => {
    const docs = await seedCard('docs', ['README.md'], 0.97);
    await updateOperatorDefaults({ judgmentProvider: 'managed' });

    const { items } = await readInbox();
    await waitForInboxUrgency();

    expect(items.find((item) => item.approvalId === docs.id)?.refereeChips?.map((chip) => chip.kind)).toEqual(['docs-only']);
  }, 60_000);

  it('with the setting off returns the payload byte for byte, the chip step adding nothing', async () => {
    await seedCard('mixed', ['src/app.ts'], 0.97);
    await seedCard('docs', ['README.md'], 0.98);

    const on = await readInbox();
    await waitForInboxUrgency();
    expect(on.text).toContain('"refereeChips"');

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await readInbox();
    expect(off.text).not.toContain('refereeChips');

    // Same persisted state: the on payload with only the chips removed is the off payload, byte for byte.
    const parsed = JSON.parse(on.text) as { items: Array<Record<string, unknown>> };
    for (const item of parsed.items) delete item.refereeChips;
    expect(withoutBuildClock(off.text)).toBe(withoutBuildClock(JSON.stringify(parsed)));
  }, 60_000);
});

describe('approve from a card with chips through the route every card uses', () => {
  it('resolves a lane-merge card exactly as the plain approve, plus the chips-shown fact on the event', async () => {
    const plain = await createDocsMergeCard('o8-chips-plain', 0.97);
    const chip = await createDocsMergeCard('o8-chips-chip', 0.97);
    const mobile = await createDocsMergeCard('o8-chips-mobile-action', 0.97);

    // Both cards are the chip shape: the phone inbox shows the chip on each.
    const { items } = await readInbox();
    await waitForInboxUrgency();
    for (const id of [plain.approval.id, chip.approval.id, mobile.approval.id]) {
      expect(items.find((item) => item.approvalId === id)?.refereeChips?.map((c) => c.kind)).toEqual(['docs-only']);
    }

    laneDispatch.calls.length = 0;
    const plainRes = await approvalsRoute.POST(approveRequest({ action: 'approve', id: plain.approval.id }));
    const chipRes = await approvalsRoute.POST(approveRequest({ action: 'approve', id: chip.approval.id, via: 'chip' }));
    const mobileRes = await mobileActionRoute.POST(mobileApproveRequest(mobile.approval.sessionKey, mobile.approval.id));
    expect(chipRes.status).toBe(plainRes.status);
    expect(mobileRes.status).toBe(plainRes.status);
    const plainBody = await plainRes.json() as { ok: boolean; note?: string };
    const chipBody = await chipRes.json() as { ok: boolean; note?: string };
    const mobileBody = await mobileRes.json() as { ok: boolean; note?: string };
    expect(chipBody.ok).toBe(plainBody.ok);
    expect(mobileBody.ok).toBe(plainBody.ok);

    // Continuation handling: the same lane command, strategy included, for both.
    expect(laneDispatch.calls).toHaveLength(3);
    const [plainCall, chipCall, mobileCall] = laneDispatch.calls;
    expect(plainCall).toMatchObject({ verb: 'merge', laneId: plain.lane.id, strategy: 'theirs', commitMessage: 'docs: notes', actor: 'user' });
    expect({ ...chipCall, laneId: '<lane>' }).toEqual({ ...plainCall, laneId: '<lane>' });
    expect({ ...mobileCall, laneId: '<lane>' }).toEqual({ ...plainCall, laneId: '<lane>' });
    expect(getLane(chip.lane.id)?.status).toBe(getLane(plain.lane.id)?.status);
    expect(getLane(mobile.lane.id)?.status).toBe(getLane(plain.lane.id)?.status);
    expect(getLane(plain.lane.id)?.status).toBe('completed');

    const plainAfter = getApproval(plain.approval.id)!;
    const chipAfter = getApproval(chip.approval.id)!;
    const mobileAfter = getApproval(mobile.approval.id)!;
    expect(plainAfter.status).toBe('approved');
    expect(chipAfter.status).toBe(plainAfter.status);
    expect(mobileAfter.status).toBe(plainAfter.status);
    const resolution = (approval: typeof plainAfter) => ({ ...approval.resolution, claimId: '<claim>', note: undefined });
    expect(resolution(chipAfter)).toEqual(resolution(plainAfter));
    expect(resolution(mobileAfter)).toEqual(resolution(plainAfter));
    expect(plainAfter.resolution).toMatchObject({ action: 'approved', actor: 'desktop' });
    expect(plainAfter.resolution).toMatchObject({ continuationStatus: 'completed' });
    expect(mobileAfter.resolution).toMatchObject({ action: 'approved', actor: 'desktop', continuationStatus: 'completed' });

    const decision = (approval: typeof plainAfter) => approval.audit.find((event) => event.type === 'approved')!;
    const plainEvent = decision(plainAfter);
    const chipEvent = decision(chipAfter);
    const mobileEvent = decision(mobileAfter);
    expect(chipEvent).toMatchObject({ type: 'approved', actor: 'desktop', approvedFromCard: { via: 'chip', chipsShown: ['docs-only'] } });
    expect({ ...mobileEvent, timestamp: 0 }).toEqual({ ...plainEvent, timestamp: 0 });
    const { approvedFromCard: _fact, ...chipEventRest } = chipEvent;
    expect({ ...chipEventRest, timestamp: 0 }).toEqual({ ...plainEvent, timestamp: 0 });
    expect(plainEvent).not.toHaveProperty('approvedFromCard');
    // Every later audit event (continuation outcome) has the same type and actor.
    const tail = (approval: typeof plainAfter) => approval.audit.map((event) => `${event.type}:${event.actor}`);
    expect(tail(chipAfter)).toEqual(tail(plainAfter));

    const [chipRow] = eventRows(chip.approval.id);
    const [plainRow] = eventRows(plain.approval.id);
    expect(plainRow).toEqual({ event_type: 'approved', actor: 'desktop', note: null, details_json: '{}' });
    expect({ ...chipRow, details_json: '<fact>' }).toEqual({ ...plainRow, details_json: '<fact>' });
    expect(JSON.parse(chipRow.details_json)).toEqual({ approvedFromCard: { via: 'chip', chipsShown: ['docs-only'] } });
  }, 120_000);

  it('forwards a persisted lane strategy and records the same actor through both approval routes', async () => {
    const continuation = (laneId: string) => ({
      kind: 'lane' as const,
      laneId,
      verb: 'merge' as const,
      strategy: 'theirs' as const,
      commitMessage: 'docs: route parity',
    });
    const panelApproval = createApproval({
      source: 'test',
      runtime: 'codex',
      agent: 'Route parity',
      sessionKey: 'codex:route-parity-panel',
      title: 'Merge through panel approval route',
      description: 'Persisted route parity fixture.',
      summary: 'route-parity-panel',
      risk: 'low',
      continuation: continuation('route-parity-panel'),
    });
    const mobileApproval = createApproval({
      source: 'test',
      runtime: 'codex',
      agent: 'Route parity',
      sessionKey: 'codex:route-parity-mobile',
      title: 'Merge through mobile action route',
      description: 'Persisted route parity fixture.',
      summary: 'route-parity-mobile',
      risk: 'low',
      continuation: continuation('route-parity-mobile'),
    });

    laneDispatch.calls.length = 0;
    const panelResponse = await approvalsRoute.POST(approveRequest({ action: 'approve', id: panelApproval.id }));
    const mobileResponse = await mobileActionRoute.POST(mobileApproveRequest(mobileApproval.sessionKey, mobileApproval.id));
    expect(panelResponse.status).toBe(200);
    expect(mobileResponse.status).toBe(200);
    expect(laneDispatch.calls).toEqual([
      expect.objectContaining({ laneId: 'route-parity-panel', verb: 'merge', strategy: 'theirs', actor: 'user' }),
      expect.objectContaining({ laneId: 'route-parity-mobile', verb: 'merge', strategy: 'theirs', actor: 'user' }),
    ]);

    const panelAfter = getApproval(panelApproval.id)!;
    const mobileAfter = getApproval(mobileApproval.id)!;
    expect(panelAfter.resolution).toMatchObject({ action: 'approved', actor: 'desktop', continuationStatus: 'completed' });
    expect(mobileAfter.resolution).toMatchObject({ action: 'approved', actor: 'desktop', continuationStatus: 'completed' });
    expect(mobileAfter.audit.find((event) => event.type === 'approved')).toMatchObject({ type: 'approved', actor: 'desktop' });
  });

  it('ignores an unknown via value', async () => {
    const card = await createDocsMergeCard('o8-chips-unknown', 0.97);
    const res = await approvalsRoute.POST(approveRequest({ action: 'approve', id: card.approval.id, via: 'swipe' }));
    expect(res.status).toBe(200);
    expect(getApproval(card.approval.id)!.audit.find((event) => event.type === 'approved')).not.toHaveProperty('approvedFromCard');
    expect(eventRows(card.approval.id)[0].details_json).toBe('{}');
  }, 120_000);
});
