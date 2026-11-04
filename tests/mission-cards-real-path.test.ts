/**
 * Mission cards (#5468) — real entry-point coverage.
 *
 * Drives the actual route handlers against persisted state: the lead emits a
 * card on its thread through the task artifact route, the card lands on the
 * mission event stream (the named packet's lane) and in the session history
 * every transcript reads, the operator's `card.decision` goes through the
 * existing delivery paths (the lead's composer queue, the operator's own
 * thread turn, or a packet steer) as a structured `card.decision` block, the
 * card takes exactly one decision, expires, and its receipt is rebuilt from
 * server state after a restart.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
  requestRealtimeRefresh: vi.fn(async () => {}),
  publishArtifactRecorded: vi.fn(async () => {}),
  publishCortexChange: vi.fn(async () => {}),
}));

const steerPacketMock = vi.hoisted(() => vi.fn(async (input: { packetId: string; message: string }) => ({
  packetId: input.packetId,
  laneId: 'lane-from-mock',
  note: 'steered by fixture',
})));
vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>(),
  steerPacket: steerPacketMock,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-cards-'));
const WORKER_TOKEN = 'local-worker-token-cafebabe0123456789abcdef01';
const WS_TOKEN = 'operator-ws-token-0123456789abcdefaaaa';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString('utf8').trim();
}

function makeRepo(name: string): string {
  const repo = join(dataDir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-q', '-m', 'init');
  return realpathSync(repo);
}

const create = await import('@/app/api/task-artifacts/route');
const decision = await import('@/app/api/task-artifacts/[id]/decision/route');
const history = await import('@/app/api/mobile/history/route');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { listQueuedComposerSends } = await import('@/lib/orchestrator/composer-queue');
const { markThreadActionDelivered } = await import('@/lib/task-artifacts/service');
const { mergeDurableMobileTranscriptEntries } = await import('@/lib/mobile/history');
const { closeDb } = await import('@/lib/db');

const BASE = 'http://localhost:3001/api/task-artifacts';
const ROUTING = { backend: 'codex', model: 'gpt-5.5', effort: 'medium', permissionMode: 'full', mode: 'fleet', pickedMode: 'fast', collide: false };

function req(url: string, init: { method?: string; body?: unknown; token?: string | null } = {}): NextRequest {
  const token = init.token === undefined ? WS_TOKEN : init.token;
  return new NextRequest(url, {
    method: init.method ?? 'GET',
    headers: {
      host: 'localhost:3001',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
let nonceSeq = 0;
const nonce = () => `nonce-${Date.now()}-${(nonceSeq += 1)}`;

interface CardEntry { id: string; type?: string; text: string; card?: { id: string; state: string; summary: string | null; receipt: { actionId: string; decidedBy: string; entityIds: string[] } | null } }

async function readCards(sessionKey: string): Promise<CardEntry[]> {
  const res = await history.GET(req(`http://localhost:3001/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=100&page=1`));
  expect(res.status).toBe(200);
  const body = await res.json() as { transcript: CardEntry[] };
  return body.transcript;
}

async function createCard(body: Record<string, unknown>, token?: string): Promise<string> {
  const res = await create.POST(req(BASE, { method: 'POST', body, token }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { result: { artifact: { id: string } } }).result.artifact.id;
}

function decide(id: string, body: Record<string, unknown>, token?: string | null) {
  return decision.POST(req(`${BASE}/${id}/decision`, { method: 'POST', body: { nonce: nonce(), ...body }, token }), params(id));
}

afterEach(() => { vi.useRealTimers(); });

describe('mission cards — real path', () => {
  const repo = makeRepo('repo-mission');
  const threadId = `thoughts-cards-${Date.now()}`;
  const packetId = `pkt-${crypto.randomUUID()}`;
  const lane = createLane({ repoPath: repo, branch: 'issue/5468', runtime: 'codex', packetId, sessionKey: 'codex-owned:card-fixture', worktreePath: repo, label: 'cards' });
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [
    { id: 'u1', role: 'user', content: 'ship the packet', timestamp: Date.now() - 60_000 },
    { id: 'a1', role: 'assistant', content: 'The packet is ready to merge.', timestamp: Date.now() - 30_000 },
  ] });
  let approveId = '';

  it('rejects a malformed card', async () => {
    const res = await create.POST(req(BASE, { method: 'POST', body: { title: 'Bad', threadId, repoPath: repo, card: { kind: 'choose', actions: [{ id: 'only', label: 'One' }] } } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_card');
  });

  it('emits an approve card on the lead thread, the mission stream, and the session history', async () => {
    approveId = await createCard({ title: 'Merge cards packet?', threadId, repoPath: repo, card: { kind: 'approve', body: 'Tests are green.', entityIds: [`packet:${packetId}`] } });
    expect(getLaneEvents(lane.id, 50)).toEqual(expect.arrayContaining([expect.objectContaining({
      verb: 'card',
      payload: expect.objectContaining({ cardId: approveId, kind: 'approve', entityIds: [`packet:${packetId}`], actions: [
        { id: 'approve', label: 'Approve', style: 'primary', confirm: 'hold' },
        { id: 'deny', label: 'Deny', style: 'danger' },
      ] }),
    })]));

    const transcript = await readCards(`llm-chat:${threadId}`);
    expect(transcript.map((entry) => entry.id)).toEqual(['u1', 'a1', `card-${approveId}`]);
    expect(transcript[2]).toMatchObject({ type: 'card', card: { id: approveId, state: 'open', receipt: null } });
  });

  it('a decision reaches the lead as structured context exactly once, and dissolves into a receipt', async () => {
    const unknownEntity = await decide(approveId, { actionId: 'approve', entityIds: ['packet:someone-else'], routing: ROUTING });
    expect(unknownEntity.status).toBe(422);
    expect(((await unknownEntity.json()) as { error: { code: string } }).error.code).toBe('invalid_entities');
    expect(await decide(approveId, { actionId: 'approve' }, mintPacketWorkerToken(packetId)).then((r) => r.status)).toBe(403);

    const res = await decide(approveId, { actionId: 'approve', entityIds: [`packet:${packetId}`], routing: ROUTING });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { deliverVia: string; action: { id: string; delivery: string }; card: { state: string; summary: string } } };
    expect(body.result.deliverVia).toBe('queue');
    expect(body.result.action.delivery).toBe('delivered');
    expect(body.result.card.state).toBe('decided');
    expect(body.result.card.summary).toMatch(/^Approve · Merge cards packet\? · by operator at \d\d:\d\d UTC$/);

    // The lead's next turn: the decision waits on the existing composer queue.
    const queued = listQueuedComposerSends({ repoPath: repo, threadId });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: body.result.action.id, intent: 'send-next', payload: { routing: ROUTING } });
    const block = /```json\n([\s\S]+)\n```/.exec(queued[0].payload.wireMessage)?.[1];
    expect(JSON.parse(block!)).toEqual({
      type: 'card.decision', cardId: approveId, kind: 'approve', title: 'Merge cards packet?',
      actionId: 'approve', actionLabel: 'Approve', entityIds: [`packet:${packetId}`],
      decidedBy: 'operator', decidedAt: expect.any(String), receiptId: body.result.action.id,
    });
    expect(getLaneEvents(lane.id, 50)).toEqual(expect.arrayContaining([expect.objectContaining({
      verb: 'card.decision', actor: 'user',
      payload: expect.objectContaining({ cardId: approveId, actionId: 'approve', receiptId: body.result.action.id, delivery: 'delivered' }),
    })]));

    const again = await decide(approveId, { actionId: 'deny', routing: ROUTING });
    expect(again.status).toBe(422);
    const refused = await again.json() as { error: { code: string; message: string }; result: { card: { state: string } } };
    expect(refused.error).toEqual({ code: 'read_only', message: 'The card was already decided.' });
    expect(refused.result.card.state).toBe('decided');
    expect(listQueuedComposerSends({ repoPath: repo, threadId })).toHaveLength(1);
  });

  it('reload rebuilds the receipt from server state', async () => {
    closeDb();
    const transcript = await readCards(`llm-chat:${threadId}`);
    const card = transcript.find((entry) => entry.id === `card-${approveId}`)!;
    expect(card.card).toMatchObject({ state: 'decided', receipt: { actionId: 'approve', decidedBy: 'operator', entityIds: [`packet:${packetId}`] } });
    expect(card.text).toBe(card.card!.summary);
    const read = await decision.GET(req(`${BASE}/${approveId}/decision`), params(approveId));
    expect(((await read.json()) as { result: { card: { state: string } } }).result.card.state).toBe('decided');
  });

  it('without a routing snapshot the decision rides the operator\'s own thread turn', async () => {
    const chooseId = await createCard({ title: 'Which base?', threadId, repoPath: repo, card: { kind: 'choose', actions: [{ id: 'main', label: 'main' }, { id: 'next', label: 'next' }] } });
    const res = await decide(chooseId, { actionId: 'next' });
    const body = await res.json() as { result: { deliverVia: string; action: { id: string; delivery: string }; wireMessage: string } };
    expect(body.result.deliverVia).toBe('thread');
    expect(body.result.action.delivery).toBe('accepted');
    expect(body.result.wireMessage).toContain('"type": "card.decision"');
    expect(markThreadActionDelivered({ artifactId: chooseId, actionId: body.result.action.id }, { repoPath: repo, threadId })).toEqual({ ok: true });
  });

  it('a packet card is decided through the packet steer path and shows in the packet session history', async () => {
    const chooseId = await createCard({ title: 'Pick a retry', card: { kind: 'choose', actions: [{ id: 'rerun', label: 'Re-run CI' }, { id: 'skip', label: 'Skip' }], entityIds: [`packet:${packetId}`] } }, mintPacketWorkerToken(packetId));
    // The history route merges this onto the packet session's runtime tail; the
    // fixture session has no runtime process, so read the merge step directly.
    expect(mergeDurableMobileTranscriptEntries('codex-owned:card-fixture', []).map((entry) => entry.id)).toEqual([`card-${chooseId}`]);
    const res = await decide(chooseId, { actionId: 'rerun' });
    const body = await res.json() as { result: { deliverVia: string; action: { delivery: string } } };
    expect(body.result).toMatchObject({ deliverVia: 'packet', action: { delivery: 'delivered' } });
    expect(steerPacketMock).toHaveBeenCalledTimes(1);
    expect(steerPacketMock.mock.calls[0][0].message).toContain('"actionId": "rerun"');
  });

  it('an expired card takes no decision and reads as an expiry receipt', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const cardId = await createCard({ title: 'Approve hotfix?', threadId, repoPath: repo, card: { kind: 'approve', expiresAt } });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(expiresAt) + 1_000 });
    const res = await decide(cardId, { actionId: 'approve', routing: ROUTING });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('The card expired without a decision.');
    const entry = (await readCards(`llm-chat:${threadId}`)).find((candidate) => candidate.id === `card-${cardId}`)!;
    expect(entry.card).toMatchObject({ state: 'expired', receipt: null });
    expect(entry.text).toMatch(/^Expired · Approve hotfix\? · no decision by \d\d:\d\d UTC$/);
    expect(listQueuedComposerSends({ repoPath: repo, threadId })).toHaveLength(1);
  });
});
