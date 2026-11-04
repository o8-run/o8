import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixtureInbox, startParityReference } from './fixtures/ws-parity-server';

type Frame = { channel: string; event: string; data?: Record<string, unknown> };
const sockets: WebSocket[] = [];
const requests: Array<{ at: number; inbox?: { etag?: string }; history?: { sessionKey: string; sinceId?: string } }> = [];
let reference: Awaited<ReturnType<typeof startParityReference>>;
let version = 0;
let syncOnlyVersion = 0;
let failSync = false;
const inbox = () => ({ ...fixtureInbox, mode: version ? 'degraded' : 'live' });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function inboxRevision(frames: Frame[]) {
  return frames.flatMap((frame) => {
    if (frame.channel !== 'realtime' || !Array.isArray(frame.data?.events)) return [];
    return (frame.data.events as Array<{ event: string; data?: { revision?: number } }>)
      .filter((event) => event.event === 'mobile.inbox.snapshot')
      .map((event) => event.data?.revision);
  }).at(-1);
}
async function waitFor(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(20);
  }
  throw new Error('Timed out waiting for WS receipt');
}
async function connect(realtime: boolean) {
  const ws = new WebSocket(`${reference.url}?token=${reference.token}`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  await once(ws, 'open');
  if (realtime) ws.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
  await waitFor(() => frames.some((frame) => frame.channel === 'inbox'));
  if (realtime) await waitFor(() => frames.some((frame) => frame.channel === 'realtime' && frame.event === 'batch'));
  return { ws, frames };
}
async function refreshInbox() {
  const response = await fetch(`${reference.url.replace('ws:', 'http:').replace('/ws', '')}/internal/realtime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reference.token}` },
    body: JSON.stringify({ kind: 'refresh', targets: ['mobileInbox'], fresh: true }),
  });
  expect(response.status).toBe(202);
}
beforeAll(async () => {
  reference = await startParityReference({ inbox, sync: async (body) => {
    const request = body as Omit<(typeof requests)[number], 'at'>;
    requests.push({ at: Date.now(), ...request });
    // Keep requests in flight long enough to expose duplicate per-socket work.
    await pause(100);
    if (failSync) return { errors: { inbox: 'temporary fixture failure', history: 'temporary fixture failure' } };
    if (request.inbox) {
      const etag = `${version}:${syncOnlyVersion}`;
      return { inboxEtag: etag, inbox: request.inbox.etag === etag ? null : {
        ...inbox(), note: `sync-only-${syncOnlyVersion}`,
      } };
    }
    const id = `entry-${version}`;
    return { history: { sessionKey: request.history?.sessionKey,
      entries: request.history?.sinceId === id ? [] : [{ id, role: 'assistant', text: `version ${version}` }] } };
  } });
}, 60_000);
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await reference?.stop();
});
it('bounds two idle native sockets and repairs sync-only changes while preserving push latency', async () => {
  const clients = await Promise.all([connect(true), connect(true)]);
  const start = requests.length;
  const idleStartedAt = Date.now();
  await pause(30_000);
  const count = requests.length - start;
  console.log(`IDLE_NATIVE duration=30s sockets=2 syncs=${count} bound=1`);
  // A bootstrap racing the first registered revision may require one shared repair.
  expect(count).toBeLessThanOrEqual(1);
  const revisions = clients.map(({ frames }) => inboxRevision(frames));
  for (const revision of revisions) expect(revision).toBeTypeOf('number');
  // Keep /api/mobile/inbox and the push revision unchanged: only /sync knows this change.
  const syncChangedAt = Date.now();
  syncOnlyVersion += 1;
  const note = `sync-only-${syncOnlyVersion}`;
  const recovered = await waitFor(() => clients.every(({ frames }) => frames.some((frame) =>
    frame.channel === 'inbox' && frame.data?.note === note)), 70_000).then(() => true, () => false);
  console.log(`SAFETY_NET_FLOOR revisionUnchanged=true sockets=2 recovered=${recovered} latencyMs=${Date.now() - syncChangedAt} bound=70000`);
  expect(recovered, 'sync-only change must arrive despite an unchanged push revision').toBe(true);
  expect(clients.map(({ frames }) => inboxRevision(frames))).toEqual(revisions);
  for (let windowStart = idleStartedAt; windowStart < Date.now(); windowStart += 30_000) {
    expect(requests.slice(start).filter((request) => request.at >= windowStart && request.at < windowStart + 30_000).length)
      .toBeLessThanOrEqual(1);
  }
  const changedAt = Date.now();
  version += 1;
  await refreshInbox();
  await waitFor(() => clients.every(({ frames }) => frames.some((frame) =>
    frame.channel === 'realtime' && JSON.stringify(frame.data).includes('degraded'))), 2_000);
  console.log(`INBOX_PUSH sockets=2 latencyMs=${Date.now() - changedAt} bound=2000`);
  for (const { ws } of clients) ws.terminate();
}, 115_000);
it('coalesces mobile history safety reads, backs off after a minute, and resumes on session switch', async () => {
  const clients = await Promise.all([connect(false), connect(false)]);
  for (const { ws } of clients) ws.send(JSON.stringify({ type: 'subscribe', sessionKey: 'fixture:idle' }));
  await waitFor(() => clients.every(({ frames }) => frames.some((frame) => frame.channel === 'history')));
  const start = requests.length;
  await pause(30_000);
  const historyRequests = requests.slice(start).filter((request) => request.history?.sessionKey === 'fixture:idle');
  console.log(`MOBILE_HISTORY duration=30s sockets=2 syncs=${historyRequests.length} bound=4`);
  expect(historyRequests.length).toBeLessThanOrEqual(4);
  expect(historyRequests.length).toBeGreaterThanOrEqual(3);
  await pause(40_000);
  const backedOffAt = requests.length;
  await pause(30_000);
  const idleRequests = requests.slice(backedOffAt).filter((request) => request.history?.sessionKey === 'fixture:idle');
  console.log(`IDLE_BACKOFF duration=30s afterIdle=70s syncs=${idleRequests.length} bound=0`);
  expect(idleRequests).toHaveLength(0);
  // A new scope must bootstrap immediately even when the previous scope is idle.
  version += 1;
  const switchedAt = Date.now();
  clients[0].ws.send(JSON.stringify({ type: 'switch-session', sessionKey: 'fixture:new' }));
  await waitFor(() => clients[0].frames.some((frame) => frame.channel === 'history' && frame.data?.sessionKey === 'fixture:new'));
  expect(Date.now() - switchedAt).toBeLessThan(2_000);
  for (const { ws } of clients) ws.terminate();
}, 110_000);
it('retries failed safety reads at the existing cadence', async () => {
  const client = await connect(false);
  failSync = true;
  client.ws.send(JSON.stringify({ type: 'subscribe', sessionKey: 'fixture:retry' }));
  await waitFor(() => requests.some((request) => request.history?.sessionKey === 'fixture:retry'));
  const start = requests.length;
  await pause(17_000);
  expect(requests.slice(start).filter((request) => request.history?.sessionKey === 'fixture:retry').length).toBeGreaterThanOrEqual(2);
  failSync = false;
  await waitFor(() => client.frames.some((frame) => frame.channel === 'history'), 9_000);
  client.ws.terminate();
}, 30_000);
