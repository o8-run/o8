import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Each side stamps its own event id and time; nothing else may differ.
function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, entry) => (key === 'id' || key === 'timestamp') ? 0 : entry);
}

// Conversation PR links and Symon's on-demand speech, served by the WS listener with Next
// stopped: the same answers as the TS handlers in this process on the same data directory.
// Mirror-only reads; the GitHub refresh path is not exercised so no provider call can happen.
it.skipIf(process.platform === 'win32')('serves PR context links and broadcast speech natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pr-context-say-')));
  const device = 'pr-context-fixture-device-0123456789abcdef';
  const worker = 'pr-context-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    const context = '/api/orchestrator/pull-request-context';
    for (const [method, path, body] of [['GET', `${context}?threadId=thoughts-fixture`], ['POST', context, {}], ['DELETE', context, {}],
      ['POST', '/api/broadcast/say', { text: 'Refused line' }]] as const) {
      expect([method, path, (await send(method, path, forged, body)).status]).toEqual([method, path, 401]);
      for (const token of [device, worker]) {
        expect([method, path, (await send(method, path, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([method, path, 403]);
      }
    }

    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      WS_TOKEN: server.token, CORTEX_REALTIME_INTERNAL_ORIGIN: origin });
    delete process.env.O8_DATA_DIR;
    const links = await import('@/app/api/orchestrator/pull-request-context/route');
    const say = await import('@/app/api/broadcast/say/route');
    const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
    const { upsertGitHubRepository, upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
    const { getSqlite } = await import('@/lib/db');

    const threadId = 'thoughts-native-context';
    writePersistedLlmChat(threadId, { title: 'Fixture conversation', repoPath: directory, repoBranch: 'main',
      messages: [{ id: 'message', role: 'user', content: 'Preserved', timestamp: 1 }] });
    upsertGitHubRepository({ repoId: 41, fullName: 'fixture/repo', owner: 'fixture', name: 'repo', private: false });
    upsertGitHubPullRequest({
      pullRequestId: 4101, repositoryId: 41, repoFullName: 'fixture/repo', number: 7, title: 'Fixture PR', state: 'open',
      author: { login: 'fixture-owner' }, body: '', headRefName: 'fixture-branch', baseRefName: 'main',
      additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [],
      url: 'https://github.com/fixture/repo/pull/7',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', closedAt: null, mergedAt: null,
    });
    const identity = { host: 'github.com', repositoryId: 41, pullRequestId: 4101, number: 7 };
    const byIdentity = `${context}?host=github.com&repositoryId=41&pullRequestId=4101&number=7`;

    const handlers: Record<string, Record<string, (request: NextRequest) => Promise<Response>>> = {
      [context]: { GET: links.GET, POST: links.POST, DELETE: links.DELETE },
      '/api/broadcast/say': { POST: say.POST },
    };
    const compare = async (method: string, path: string, body?: unknown) => {
      const native = await send(method, path, operator, body);
      const ts = await handlers[path.split('?')[0]][method](new NextRequest(`http://127.0.0.1${path}`, { method,
        headers: { ...operator, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
      expect([method, path, native.status, native.headers.get('cache-control')]).toEqual([method, path, ts.status, ts.headers.get('cache-control')]);
      return [native.status, await native.json(), await ts.json()] as const;
    };
    const same = async (method: string, path: string, body?: unknown) => {
      const [status, native, ts] = await compare(method, path, body);
      expect([method, path, native]).toEqual([method, path, ts]);
      return [status, native] as const;
    };

    // Refusals and reads with nothing linked match.
    for (const path of [context, `${context}?threadId=bad`, `${context}?threadId=thoughts-missing`, `${context}?threadId=${threadId}&repo=fixture/repo`,
      `${context}?threadId=${threadId}&limit=0`, `${context}?repo=fixture/unknown&number=7`, `${context}?threadId=${threadId}`, byIdentity,
      `${context}?repo=fixture/repo&number=7&resolve=1`]) await same('GET', path);
    for (const body of [[], { threadId, ...identity, kind: 'bogus' }, { threadId: 'thoughts-missing', ...identity },
      { threadId, ...identity, pullRequestId: 4102 }, { threadId, ...identity, source: 'packet' }]) await same('POST', context, body);

    // A native link, the same link from TS (already present), the reads both ways, then removal.
    const first = await send('POST', context, operator, { threadId, ...identity, kind: 'review' });
    const nativeLink = await first.json();
    expect([first.status, (nativeLink as { result: { created: boolean } }).result.created]).toEqual([201, true]);
    const [again, repeated] = await same('POST', context, { threadId, ...identity, kind: 'review' });
    expect([again, (repeated as { result: { created: boolean } }).result.created]).toEqual([200, false]);
    expect((nativeLink as { result: { link: unknown } }).result.link).toEqual((repeated as { result: { link: unknown } }).result.link);
    for (const path of [`${context}?threadId=${threadId}`, byIdentity, `${context}?threadId=${threadId}&limit=1`]) {
      const [, listed] = await same('GET', path);
      expect((listed as { result: { links: Array<{ kind: string; url: string }> } }).result.links.map((link) => [link.kind, link.url]))
        .toEqual([['review', 'https://github.com/fixture/repo/pull/7']]);
    }
    const [, removed] = await compare('DELETE', context, { threadId, ...identity, kind: 'review' });
    expect(removed).toEqual({ ok: true, result: { removed: true } });
    await same('DELETE', context, { threadId, ...identity, kind: 'review' });
    await same('GET', `${context}?threadId=${threadId}`);

    // Speech: refusals match, then one line from each side lands in the shared feed.
    for (const body of [[], {}, { text: '' }]) await same('POST', '/api/broadcast/say', body);
    const [spoken, nativeLine, tsLine] = await compare('POST', '/api/broadcast/say', { text: 'Fixture spoken line' });
    expect([spoken, stable(nativeLine)]).toEqual([200, stable(tsLine)]);
    const stored = getSqlite().prepare(`SELECT COUNT(*) AS count FROM broadcast_events WHERE text = ?`).get('Fixture spoken line') as { count: number };
    expect(stored.count).toBe(2);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
