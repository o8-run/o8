/**
 * Real-path regression for the mission-archive sidebar class (#1848).
 *
 * The closed-issue test drove `archiveMissionThread` against a fake fetch and
 * asserted the OUTBOUND REQUEST BODY, so it stayed green while the persistence
 * route dropped the title on the floor and the list route filed the snapshot in
 * the live Chats rail. This drives the same entry point into the REAL
 * `/api/v2/chat-history` POST/GET/DELETE handlers, the real store, and the real
 * `/api/v2/chat-history/list` verdict, then asserts what an operator sees:
 *
 *   1. the mission-specific title survives persistence,
 *   2. the snapshot is archived — absent from the default list, present under
 *      archived=only / archived=include,
 *   3. a mission-completed replay after a restart cannot mint a second archive,
 *   4. the archived transcript is preserved verbatim,
 *   5. the lifecycle detector claiming the mission's completion CARD does not
 *      suppress the first archive — card delivery and archive persistence are
 *      different facts and must not share a guard,
 *   6. the "already archived?" probe reads absence from the route's explicit
 *      `exists: false`, while an unknown failure fails closed rather than
 *      cutting a duplicate and retiring the live thread,
 *   7. a blank mission identity — which the completion path proves cannot
 *      happen — writes nothing and destroys nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  DELETE as chatHistoryDELETE,
  GET as chatHistoryGET,
  POST as chatHistoryPOST,
} from '@/app/api/v2/chat-history/route';
import { GET as chatHistoryListGET } from '@/app/api/v2/chat-history/list/route';
import { serializeThoughtsHistoryMessages } from '@/lib/orchestrator/history-transcript';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const repoPath = `/tmp/o8-mission-archive-${process.pid}`;

interface ListedConversation {
  tabId: string;
  title: string;
  messageCount: number;
  repoPath?: string | null;
  archivedAt?: string | null;
}

/** Routes the archiver's relative-URL fetches into the real route handlers. */
function installRealRouteFetch(historyGetOverride?: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('/api/v2/chat-history/list')) {
      return chatHistoryListGET(new NextRequest(`http://localhost${url}`));
    }
    if (url.startsWith('/api/v2/chat-history')) {
      // Only the archiver's own reads are swapped; persistence stays real.
      if (method === 'GET' && historyGetOverride) return historyGetOverride();
      if (method === 'POST') {
        return chatHistoryPOST(new NextRequest('http://localhost/api/v2/chat-history', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: String(init?.body ?? '{}'),
        }));
      }
      if (method === 'DELETE') return chatHistoryDELETE(new NextRequest(`http://localhost${url}`));
      return chatHistoryGET(new NextRequest(`http://localhost${url}`));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** localStorage that survives a simulated app restart, like the real browser's. */
const persistentStorage = new Map<string, string>();

function installWindow() {
  const storage = {
    getItem: (key: string) => persistentStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { persistentStorage.set(key, value); },
    removeItem: (key: string) => { persistentStorage.delete(key); },
  };
  vi.stubGlobal('window', {
    // The store patches `window.fetch` at import time (orchestrator turn pins);
    // the archiver itself calls the global, which the route router below owns.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
    localStorage: new Proxy(storage, {
      ownKeys: () => [...persistentStorage.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
    setTimeout: () => 1,
  });
}

/**
 * A fresh app session: module state (the in-memory rotated-mission dedupe and
 * the carded-mission cache) starts empty, exactly as it does after a restart.
 */
async function bootAppSession(historyGetOverride?: () => Response) {
  vi.resetModules();
  installWindow();
  const fetchMock = installRealRouteFetch(historyGetOverride);
  const sessionModule = await import('@/components/desktop/thoughts/use-orchestrator-stream/mission-history');
  const storeModule = await import('@/lib/orchestrator/store');
  return {
    fetchMock,
    archiveMissionThread: sessionModule.archiveMissionThread,
    missionArchiveTabId: sessionModule.missionArchiveTabId,
    // The same module instance the archiver sees — so a test that claims the
    // completion card claims it exactly where the lifecycle detector would.
    markMissionCarded: storeModule.markMissionCarded,
  };
}

async function listConversations(query: string): Promise<ListedConversation[]> {
  const response = await chatHistoryListGET(
    new NextRequest(`http://localhost/api/v2/chat-history/list?${query}`),
  );
  const payload = await response.json() as { conversations?: ListedConversation[] };
  return (payload.conversations ?? []).filter((entry) => entry.repoPath === repoPath);
}

async function seedLiveThread(tabId: string, transcript: MobileTranscriptEntry[]) {
  await chatHistoryPOST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tabId,
      replace: true,
      messages: serializeThoughtsHistoryMessages(transcript),
      model: 'claude-code',
      repoPath,
    }),
  }));
}

/** Archive id for an identified mission — nonblank ids always resolve to one. */
function requireArchiveId(tabId: string | null): string {
  if (!tabId) throw new Error('expected an archive id for an identified mission');
  return tabId;
}

async function readStoredMessages(tabId: string): Promise<Array<{ role: string; content: string }>> {
  const response = await chatHistoryGET(
    new NextRequest(`http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`),
  );
  const payload = await response.json() as { messages?: Array<{ role: string; content: string }> };
  return payload.messages ?? [];
}

/** The long-lived thread from the live incident: a generic opening question. */
const openingMessage: MobileTranscriptEntry = {
  id: 'user-1',
  role: 'user',
  text: 'What is o8, in your own words',
  timestamp: 1_000,
};

function threadTranscript(extra: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  return [
    openingMessage,
    { id: 'assistant-1', role: 'assistant', text: 'o8 is the governance layer.', timestamp: 1_001 },
    ...extra,
  ];
}

function missionDetail(missionId: string, packetTitle: string) {
  return {
    missionId,
    repoPath,
    summary: 'o8 with 1 task',
    mergedCount: 1,
    archivedCount: 1,
    completedAt: '2026-09-04T12:00:00.000Z',
    packets: [{ id: `${missionId}-p1`, title: packetTitle, referenceLabel: 'P1' }],
  };
}

function archiveOptions(transcript: MobileTranscriptEntry[]) {
  return {
    planText: null,
    replaceTranscript: vi.fn(),
    getTranscript: () => transcript,
    repoPath,
    reset: vi.fn(),
    transcript,
    transitionStripTimerRef: { current: null as number | null },
  };
}

describe('mission archive persistence — real route/store/list path (#1848)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the mission title and files the snapshot as archived', async () => {
    const { archiveMissionThread, missionArchiveTabId } = await bootAppSession();
    const liveTabId = `thoughts-live-a-${process.pid}`;
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Add a dark mode toggle to the broadcast strip.', timestamp: 1_002 },
    ]);
    await seedLiveThread(liveTabId, transcript);
    persistentStorage.set(`o8:transcript-reading:v1:${JSON.stringify([repoPath, 'thread', liveTabId])}`, JSON.stringify({ following: false, top: 100, anchor: null }));

    await archiveMissionThread(
      missionDetail('mission-archive-title', 'Add broadcast dark mode toggle'),
      archiveOptions(transcript),
    );

    // The id is mission-scoped, not wall-clock — that identity is what makes a
    // replay resolve to this same record instead of minting another one.
    const archiveTabId = requireArchiveId(missionArchiveTabId('mission-archive-title'));
    expect(archiveTabId.endsWith('-archive')).toBe(true);
    const archived = (await listConversations('include=orchestrator&archived=only'))
      .filter((entry) => entry.tabId === archiveTabId);
    expect(archived).toHaveLength(1);
    // The explicit mission title reaches disk — it is not dropped and then
    // back-filled from the thread's opening message by the auto-titler.
    expect(archived[0].title).toBe('Add broadcast dark mode toggle');
    expect(archived[0].title).not.toBe(openingMessage.text);
    expect(archived[0].archivedAt).toBeTruthy();

    // The default Chats rail no longer carries the snapshot; archived=include does.
    const defaultList = await listConversations('include=orchestrator');
    expect(defaultList.map((entry) => entry.tabId)).not.toContain(archiveTabId);
    const inclusiveList = await listConversations('include=orchestrator&archived=include');
    expect(inclusiveList.map((entry) => entry.tabId)).toContain(archiveTabId);

    // History is preserved verbatim in the snapshot.
    expect((await readStoredMessages(archiveTabId)).map((message) => message.content))
      .toEqual(transcript.map((entry) => entry.text));

    // The rotated live thread is retired, so the next boot has nothing to re-cut.
    expect(await readStoredMessages(liveTabId)).toHaveLength(0);
    expect(persistentStorage.has(`o8:transcript-reading:v1:${JSON.stringify([repoPath, 'thread', liveTabId])}`)).toBe(false);
  });

  it('still archives when the lifecycle detector already claimed the completion card', async () => {
    const missionId = `mission-carded-first-${process.pid}`;
    const { archiveMissionThread, markMissionCarded } = await bootAppSession();
    const liveTabId = `thoughts-live-c-${process.pid}`;
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Tighten the packet card density.', timestamp: 1_002 },
    ]);
    await seedLiveThread(liveTabId, transcript);

    // The status-feed detector claims the mission BEFORE it delivers the card;
    // an archive guard keyed on that claim would silently drop this snapshot.
    markMissionCarded(missionId);

    await archiveMissionThread(
      missionDetail(missionId, 'Tighten packet card density'),
      archiveOptions(transcript),
    );

    const archived = await listConversations('include=orchestrator&archived=only');
    const cardedArchive = archived.find((entry) => entry.title === 'Tighten packet card density');
    expect(cardedArchive).toBeDefined();
    expect(await readStoredMessages(cardedArchive!.tabId)).toHaveLength(transcript.length);
  });

  it('cannot mint a second archive when mission completion replays after a restart', async () => {
    const missionId = `mission-replay-${process.pid}`;
    const { archiveMissionThread: archiveInFirstSession } = await bootAppSession();
    const firstTabId = `thoughts-live-b1-${process.pid}`;
    const firstTranscript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Fix the broadcast reconnect storm.', timestamp: 1_002 },
    ]);
    await seedLiveThread(firstTabId, firstTranscript);
    await archiveInFirstSession(
      missionDetail(missionId, 'Fix broadcast reconnect storm'),
      archiveOptions(firstTranscript),
    );

    const afterFirst = await listConversations('include=orchestrator&archived=only');
    const beforeReplay = afterFirst.map((entry) => entry.tabId);

    // Restart: module-scope dedupe is gone, the mission snapshot loads
    // non-terminal→terminal again, and the operator has a NEW live thread open.
    const { archiveMissionThread: archiveAfterRestart } = await bootAppSession();
    const nextTabId = `thoughts-live-b2-${process.pid}`;
    const nextTranscript = threadTranscript([
      { id: 'user-3', role: 'user', text: 'Now start on the packet card density pass.', timestamp: 2_002 },
    ]);
    await seedLiveThread(nextTabId, nextTranscript);
    await archiveAfterRestart(
      missionDetail(missionId, 'Fix broadcast reconnect storm'),
      archiveOptions(nextTranscript),
    );

    // No second snapshot, and the operator's new live thread is untouched.
    expect((await listConversations('include=orchestrator&archived=only')).map((entry) => entry.tabId))
      .toEqual(beforeReplay);
    expect(await readStoredMessages(nextTabId)).toHaveLength(nextTranscript.length);
  });

  it('reads the route\'s explicit exists:false as absent and writes the first archive', async () => {
    const { archiveMissionThread, missionArchiveTabId } = await bootAppSession();
    const archiveTabId = requireArchiveId(missionArchiveTabId('mission-probe-absent'));

    // Pin the contract the probe depends on: an unwritten tabId answers 200 and
    // states its absence outright. If that ever becomes a non-OK status the
    // probe fails closed, and this test goes red rather than the feature
    // silently going quiet.
    const probe = await chatHistoryGET(new NextRequest(
      `http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(archiveTabId)}`,
    ));
    expect(probe.status).toBe(200);
    const probeBody = await probe.json() as { exists?: unknown; messages?: unknown[] };
    expect(probeBody.exists).toBe(false);
    expect(probeBody.messages ?? []).toHaveLength(0);

    // And the archiver reads that answer as "not archived yet".
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Ship the archived-thread rail.', timestamp: 1_002 },
    ]);
    await archiveMissionThread(
      missionDetail('mission-probe-absent', 'Ship archived thread rail'),
      archiveOptions(transcript),
    );
    expect(await readStoredMessages(archiveTabId)).toHaveLength(transcript.length);
  });

  it('reads each probe shape for what it says about the stored record', async () => {
    const probeBody = (body: Record<string, unknown>) => () => new Response(JSON.stringify(body));
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Probe shape coverage.', timestamp: 1_002 },
    ]);

    // Explicit absence, stated by the field rather than inferred from a payload
    // the response need not carry: archive proceeds.
    const explicit = await bootAppSession(probeBody({ exists: false }));
    await explicit.archiveMissionThread(
      missionDetail('mission-probe-exists-false', 'Probe exists false'),
      archiveOptions(transcript),
    );
    expect(await readStoredMessages(requireArchiveId(explicit.missionArchiveTabId('mission-probe-exists-false'))))
      .toHaveLength(transcript.length);

    // A record that is present but holds no snapshot: archive proceeds, so an
    // empty placeholder can never permanently block the write that fills it.
    const empty = await bootAppSession(probeBody({ messages: [] }));
    await empty.archiveMissionThread(
      missionDetail('mission-probe-empty', 'Probe empty record'),
      archiveOptions(transcript),
    );
    expect(await readStoredMessages(requireArchiveId(empty.missionArchiveTabId('mission-probe-empty'))))
      .toHaveLength(transcript.length);

    // A shape that states neither fact is an unknown state, not an absence.
    const unreadable = await bootAppSession(probeBody({}));
    await unreadable.archiveMissionThread(
      missionDetail('mission-probe-unreadable', 'Probe unreadable'),
      archiveOptions(transcript),
    );
    expect(await readStoredMessages(requireArchiveId(unreadable.missionArchiveTabId('mission-probe-unreadable'))))
      .toHaveLength(0);
  });

  it('fails closed on an unknown probe failure — no duplicate, live thread intact', async () => {
    const { archiveMissionThread, missionArchiveTabId } = await bootAppSession(
      () => new Response('boom', { status: 500 }),
    );
    const liveTabId = `thoughts-live-e-${process.pid}`;
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Probe failure should not lose this thread.', timestamp: 1_002 },
    ]);
    await seedLiveThread(liveTabId, transcript);

    await archiveMissionThread(
      missionDetail('mission-probe-500', 'Probe failure guard'),
      archiveOptions(transcript),
    );

    expect(await readStoredMessages(requireArchiveId(missionArchiveTabId('mission-probe-500')))).toHaveLength(0);
    // The mission stays rotatable: nothing was cut and nothing was retired.
    expect(await readStoredMessages(liveTabId)).toHaveLength(transcript.length);
  });

  it('gives ids that sanitize alike distinct archive records', async () => {
    const { missionArchiveTabId } = await bootAppSession();
    // Mission ids are not charset-constrained, so a sanitize-and-truncate id
    // would alias these two onto one record and drop a real mission's snapshot.
    expect(missionArchiveTabId('mission/alpha')).not.toBe(missionArchiveTabId('mission_alpha'));
    const longPrefix = `mission-${'x'.repeat(120)}`;
    expect(missionArchiveTabId(`${longPrefix}-one`)).not.toBe(missionArchiveTabId(`${longPrefix}-two`));
    // Same id in, same record out — that is what makes a replay a no-op.
    expect(missionArchiveTabId('mission/alpha')).toBe(missionArchiveTabId('mission/alpha'));
  });

  it('writes nothing and destroys nothing when mission identity is blank', async () => {
    const { archiveMissionThread, missionArchiveTabId, fetchMock } = await bootAppSession();
    // `buildMissionCompletedDetail` proves the id is nonblank before it emits,
    // so reaching here blank is a broken invariant. There is no identity to
    // dedupe on, so inventing one would mint a snapshot on every replay.
    expect(missionArchiveTabId('')).toBeNull();
    expect(missionArchiveTabId('   ')).toBeNull();
    expect(missionArchiveTabId(null)).toBeNull();

    const liveTabId = `thoughts-live-f-${process.pid}`;
    const transcript = threadTranscript([
      { id: 'user-2', role: 'user', text: 'Blank identity must not lose this thread.', timestamp: 1_002 },
    ]);
    await seedLiveThread(liveTabId, transcript);
    const before = (await listConversations('include=orchestrator&archived=only'))
      .map((entry) => entry.tabId);
    const reset = vi.fn();
    const callsBefore = fetchMock.mock.calls.length;

    await archiveMissionThread(
      { ...missionDetail('', 'Blank identity'), missionId: '' },
      { ...archiveOptions(transcript), reset },
    );

    // Nothing is even attempted — no probe, no list scan, no write, no delete.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    // No snapshot minted...
    expect((await listConversations('include=orchestrator&archived=only')).map((entry) => entry.tabId))
      .toEqual(before);
    // ...and the live thread is neither retired nor reset.
    expect(await readStoredMessages(liveTabId)).toHaveLength(transcript.length);
    expect(reset).not.toHaveBeenCalled();
  });
});
