/**
 * #2441 — record-only push gate, through the real push mappers.
 *
 * Real-path doctrine: approvals go through the real `createApproval` (which
 * fires the approval push), agent completions through the real
 * `notifyAgentFinished` mapper ws-server calls, lanes and push subscriptions
 * are persisted rows in this file's temp data dir, the provider setting goes
 * through the real operator-defaults store, the gate call goes over HTTP to
 * the local systemone fixture, and `push_gate` events and receipts are read
 * back from SQLite. Stubbed: the Web Push transport at `sendPushToSubscription`.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({ sent: [] as Array<{ endpoint: string; payload: unknown }> }));

vi.mock('@/lib/push/send', () => ({
  sendPushToSubscription: async (sub: { endpoint: string }, payload: unknown) => {
    h.sent.push({ endpoint: sub.endpoint, payload });
    return { endpoint: sub.endpoint, ok: true, status: 201 };
  },
}));

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
};
const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-push-gate-'));
const dataDir = join(testRoot, 'data');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { createApproval } = await import('@/lib/approvals/store');
const { upsertPushSubscription } = await import('@/lib/push/store');
const { notifyAgentFinished } = await import('@/lib/push/notify');
const { setPushGateTransportForTests, waitForPushGates } = await import('@/lib/push/push-gate');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const KEY = 'ts-fixture-key-push-gate-2441';
const APPROVAL_TITLE = 'Merge the billing reconcile packet';
const APPROVAL_SUMMARY = 'Worker says every reconcile test passed';
const repoPath = join(testRoot, 'secret-repo-name');

let fixture: JudgmentEndpointFixture;
let seq = 0;

function gateReply(p: number) {
  return { status: 200, delayMs: 5, body: { model: 'jev-fixture', answers: { attentionNow: { type: 'noul', noul: p } }, usage: { input_tokens: 120, output_tokens: 4 } } };
}

function newLane() {
  seq += 1;
  return createLane({ repoPath, branch: `inline/pkt-push-${seq}`, baseBranch: 'main', runtime: 'codex', label: APPROVAL_TITLE, packetId: `pkt-push-${seq}`, sessionKey: `agent-push-${seq}` });
}

function pushGateEvents(laneId: string) {
  return (getSqlite().prepare("SELECT actor, payload_json FROM lane_events WHERE lane_id = ? AND verb = 'push_gate'").all(laneId) as Array<{ actor: string; payload_json: string }>)
    .map((row) => ({ actor: row.actor, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

/** Create an approval through the real store and wait for its push (and gate) to settle. */
async function approvalPush(laneId: string) {
  const before = h.sent.length;
  seq += 1;
  const approval = createApproval({
    source: 'runtime', runtime: 'codex', agent: 'codex', sessionKey: `approval-session-${seq}`,
    title: APPROVAL_TITLE, description: APPROVAL_SUMMARY, summary: APPROVAL_SUMMARY, risk: 'medium',
    gateResult: { passed: true, violations: [] },
    continuation: { kind: 'lane', laneId, verb: 'merge' },
  });
  await vi.waitFor(() => expect(h.sent.length).toBe(before + 1));
  await waitForPushGates();
  return { approval, payload: h.sent[before].payload };
}

async function agentPush(sessionName: string) {
  const before = h.sent.length;
  notifyAgentFinished({ sessionName, state: 'completed', exitCode: 0 });
  await vi.waitFor(() => expect(h.sent.length).toBe(before + 1));
  await waitForPushGates();
  return h.sent[before].payload;
}

const withoutId = (payload: unknown, id: string) => JSON.stringify(payload).split(id).join('<id>');

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  setPushGateTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  upsertPushSubscription({ endpoint: 'https://push.example.test/sub-1', p256dh: 'p256dh-key', auth: 'auth-key' });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  setPushGateTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

describe('record-only push gate through the real push mappers', () => {
  it('(a, d) an approval still pushes the baseline payload and records an operator-gated push_gate event; the state carries no title or text', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const offLane = newLane();
    const off = await approvalPush(offLane.id);

    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    fixture.replies.push(gateReply(0.05));
    const lane = newLane();
    const on = await approvalPush(lane.id);

    expect(withoutId(on.payload, on.approval.id)).toBe(withoutId(off.payload, off.approval.id));
    const events = pushGateEvents(lane.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ kind: 'approval_created', p: 0.05, operatorGated: true, wouldSuppress: false });
    // A receipt with a lane is stored as that lane's `judgment` event.
    const receipts = (getSqlite().prepare("SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'judgment'").all(lane.id) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ receiptId: events[0].payload.receiptId, surface: 'push-gate', ok: true, packetId: lane.packetId, approvalId: on.approval.id });

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: Record<string, unknown> };
    const serialized = JSON.stringify(body);
    for (const text of [APPROVAL_TITLE, APPROVAL_SUMMARY, 'Approval needed', 'secret-repo-name', lane.sessionKey!]) {
      expect(serialized).not.toContain(text);
    }
    expect(Object.keys(body.state).sort()).toEqual(['ageMs', 'gate', 'hourOfDay', 'kind', 'laneState', 'operatorGated', 'packetOutcome', 'quietMode', 'referee'].sort());
    expect(body.state).toMatchObject({ kind: 'approval_created', gate: { passed: true }, operatorGated: true, quietMode: false });
  }, 30_000);

  it('(b) agent_finished with p=0.1 still pushes and records wouldSuppress: true', async () => {
    const lane = newLane();
    fixture.replies.push(gateReply(0.1));
    const payload = await agentPush(lane.sessionKey!);
    expect(payload).toMatchObject({ title: `${lane.sessionKey} finished`, tag: `agent-${lane.sessionKey}` });
    expect(pushGateEvents(lane.id).map((event) => event.payload)).toEqual([
      expect.objectContaining({ kind: 'agent_finished', p: 0.1, wouldSuppress: true, operatorGated: false }),
    ]);
    expect((fixture.seen[0].body as { state: Record<string, unknown> }).state).toMatchObject({ kind: 'agent_finished', packetOutcome: 'completed', laneState: lane.status });
  }, 30_000);

  it('(c) agent_finished with p=0.9 pushes and records wouldSuppress: false', async () => {
    const lane = newLane();
    fixture.replies.push(gateReply(0.9));
    await agentPush(lane.sessionKey!);
    expect(pushGateEvents(lane.id).map((event) => event.payload)).toEqual([
      expect.objectContaining({ kind: 'agent_finished', p: 0.9, wouldSuppress: false, operatorGated: false }),
    ]);
  }, 30_000);

  it('(e) setting off: byte-identical payloads, zero provider requests, no events', async () => {
    const lane = newLane();
    fixture.replies.push(gateReply(0.2));
    const on = await agentPush(lane.sessionKey!);

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    fixture.reset();
    const offLane = newLane();
    const off = await agentPush(lane.sessionKey!);
    const offApproval = await approvalPush(offLane.id);
    const offAgent = await agentPush(offLane.sessionKey!);

    expect(JSON.stringify(off)).toBe(JSON.stringify(on));
    expect(offApproval.payload).toBeTruthy();
    expect(offAgent).toBeTruthy();
    expect(fixture.seen).toHaveLength(0);
    expect(pushGateEvents(offLane.id)).toHaveLength(0);
    expect(getSqlite().prepare("SELECT COUNT(*) AS n FROM lane_events WHERE lane_id = ? AND verb = 'judgment'").get(offLane.id)).toEqual({ n: 0 });
    expect(pushGateEvents(lane.id)).toHaveLength(1);
  }, 30_000);

  it('(f) the pushGate replay label scores recorded events against operator action and sends nothing', async () => {
    const acted = newLane();
    const ignored = newLane();
    fixture.replies.push(gateReply(0.3), gateReply(0.7));
    await agentPush(acted.sessionKey!);
    await agentPush(ignored.sessionKey!);
    recordLaneEvent(acted.id, 'update', 'user', {});
    fixture.reset();

    const stdout: string[] = [];
    const code = await runReplay(['--label', 'pushGate'], { stdout: (text: string) => stdout.push(text), stderr: () => undefined });
    const text = stdout.join('\n');
    const recorded = (getSqlite().prepare("SELECT COUNT(*) AS n FROM lane_events WHERE verb = 'push_gate'").get() as { n: number }).n;
    expect(code).toBe(0);
    expect(fixture.seen).toHaveLength(0);
    expect(text).toContain(`push_gate events read: ${recorded}; without p: 0; window 30 min`);
    expect(text).toMatch(new RegExp(`pushGate by p\\(attention now\\): n=${recorded} recorded pushes`));
    expect(text).toMatch(/false suppressions \(operator acted\) 1$/m);
  }, 30_000);
});
