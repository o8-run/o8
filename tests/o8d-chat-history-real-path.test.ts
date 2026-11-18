import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ensureMobileDeviceSchema } from '@/lib/db/mobile-device-schema';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug/o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['test', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir, '--test', 'chat_history_reads']);
}, 900_000);
const route = '/api/v2/chat-history';
const pathFor = (tabId?: string, params: Record<string, string> = {}) => route + '?' + new URLSearchParams({ ...(tabId === undefined ? {} : { tabId }), ...params });
async function snapshot(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), body: await response.json() as Record<string, unknown> };
}

it('real network projection is a no-op for a non-network tab, even with its history lock held', async () => {
  const { getCanonicalChatHistoryPath } = await import('@/lib/llm/chat-history-store');
  const { isNetworkThread } = await import('@/lib/bots/network-store');
  const { projectNetworkThread } = await import('@/lib/bots/network-projection');
  const { recordNetworkProjectionHealth, networkProjectionError } = await import('@/lib/bots/network-health');
  const { ensureV77BotNetworkThreadSchema } = await import('@/lib/db/v77-bot-network-thread-migration');
  const db = new Database(':memory:');
  const tabId = 'native-non-network-noop'; const file = getCanonicalChatHistoryPath(tabId); const lock = file + '.lock';
  mkdirSync(join(file, '..'), { recursive: true });
  const bytes = '{"messages":[{"id":"m","role":"user","content":"ordinary"}]}';
  try {
    ensureV77BotNetworkThreadSchema(db); writeFileSync(file, bytes); writeFileSync(lock, 'held-noop-lock');
    recordNetworkProjectionHealth(tabId, new Error('prior projection health'));
    const before = statSync(file); const lockBefore = statSync(lock);
    const dbState = () => [db.prepare('SELECT total_changes() AS n').get(), db.pragma('schema_version')];
    const initial = dbState();
    expect(isNetworkThread(tabId, db)).toBe(false);
    expect(projectNetworkThread(tabId, db, { waitForLock: false })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(bytes); expect(statSync(file)).toMatchObject({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    expect(readFileSync(lock, 'utf8')).toBe('held-noop-lock'); expect(statSync(lock)).toMatchObject({ ino: lockBefore.ino, size: lockBefore.size, mtimeMs: lockBefore.mtimeMs, ctimeMs: lockBefore.ctimeMs });
    expect(networkProjectionError(tabId)).toBe('prior projection health'); expect(dbState()).toEqual(initial);
  } finally { recordNetworkProjectionHealth(tabId, null); db.close(); rmSync(file, { force: true }); rmSync(lock, { force: true }); }
});

it.skipIf(process.platform !== 'linux')('reads window history through the public socket with paging parity, live classification and canonical Node writes', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-chat-history-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const deviceToken = 'd7'.repeat(32); const workerToken = 'history-fixture-worker';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(directory, 'mobile-device-tokens'), hash(deviceToken) + '\n');
    writeFileSync(join(directory, 'worker-token'), workerToken);
    const history = join(directory, 'chat-history'); mkdirSync(history, { recursive: true });
    const historyPath = (id: string) => join(history, id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    const save = (id: string, record: unknown) => writeFileSync(historyPath(id), JSON.stringify(record));
    const repo = join(directory, 'identity-repo'); mkdirSync(repo);
    await promisify(execFile)('git', ['init', '--quiet', repo]);
    await promisify(execFile)('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/FixtureOwner/FixtureRepo.git']);
    const message = { role: 'user', content: 'legacy 😀', costUsd: 0.000001, timestamp: 1, details: { '10': 'ten', '2': 'two', '\ue000': 1, '😀': 2 } };
    save('ordinary', { messages: [{ id: ' first ', role: 'user', content: 'hello', timestamp: 1 }, message, message, { id: 'last', role: 'assistant', content: 'done', timestamp: 4 }], model: 'fixture', savedAt: '2026-01-01', projectId: ' \ufeffproject-a\u00a0 ', repoPath: ' ' + repo + ' ', remoteUrl: 'git@github.com:Fallback/Other.git', custom: { ratio: 1e21, minusZero: -0 } });
    const { ensureStableChatMessageIds } = await import('@/lib/llm/chat-history-pagination');
    const reservedId = ensureStableChatMessageIds([message])[0].id;
    save('collision', { messages: [{ id: reservedId, content: 'reserved' }, message, message, { id: ' \ufeff ', content: 'blank id' }, { id: 0, content: 'numeric id' }] });
    save('decimal', { messages: [1e-7, 1e-6, 1e20, 1e21, -0, 0.12345678901234566, 9007199254740992].map(costUsd => ({ role: 'assistant', content: 'number', costUsd })), custom: { '\ue000': 2, '😀': 1 } });
    save('duplicate-ids', { messages: [{ id: 'repeat', content: 'one' }, { id: 'repeat', content: 'two' }] });
    save('empty-project', { messages: [], projectId: '\ufeff \n' });
    save('emoji-😀', { messages: [{ role: 'assistant', content: 'UTF16 filename' }] });
    save('fallback-identity', { messages: [], remoteUrl: 'prefixGitHub.com:Owner/Repo.git?view=1' });
    save('source-only-network', { source: 'bot-network', messages: [], network: { conversationId: null, canReply: false } });
    save('bound-network', { source: 'bot-network', messages: [{ id: 'network-turn', role: 'user', content: 'preserved projected turn' }], network: { conversationId: null, canReply: false } });
    writeFileSync(historyPath('bound-network') + '.lock', 'fixture-held-lock');
    const db = new Database(join(directory, 'cortex-ide.db'));
    try { ensureMobileDeviceSchema(db); db.prepare('INSERT INTO mobile_devices (id,token_hash,identity_public_key) VALUES (?,?,?)').run('history-device', hash(deviceToken), 'fixture-identity'); db.prepare('INSERT INTO bot_network_threads (thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES (?,?,NULL,?,?,?)').run('bound-network', repo, '[]', 'Network fixture', '2026-01-01T00:00:00.000Z'); } finally { db.close(); }
    writeFileSync(historyPath('malformed'), '{"messages":[');
    save('unsupported', { messages: [null, 1, ['array'], { role: 'user', content: 'TS filters unsupported rows' }] });
    save('no-messages', { title: 'TS supplies empty messages' });
    save('prototype-key', JSON.parse('{"messages":[{"role":"user","__proto__":{"x":1}}]}'));
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, bearer = token) => {
      utimesSync(historyPath('bound-network') + '.lock', new Date(), new Date());
      return fetch(server!.origin + path, { headers: { authorization: `Bearer ${bearer}` } });
    };
    const duplicatePage = await snapshot(await call(pathFor('duplicate-ids', { limit: '1' })));
    const duplicateCursor = (duplicatePage.body.page as { beforeCursor: string }).beforeCursor;
    const firstPage = await snapshot(await call(pathFor('ordinary', { limit: '2' })));
    const cursor = (firstPage.body.page as { beforeCursor: string }).beforeCursor;
    expect(cursor).toBeTypeOf('string');
    const stale = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), revision: 'stale' })).toString('base64url');
    const cases = [pathFor(), pathFor('missing'), pathFor('ordinary'), pathFor('ordinary', { limit: '2' }), pathFor('ordinary', { limit: '2', before: cursor }), pathFor('ordinary', { before: stale }), pathFor('empty-project'), pathFor('emoji-😀'), pathFor('fallback-identity'), ...['', 'bad', '0x2', '0b10', '2.9', 'Infinity', '1e9', '\ufeff 2 '].map(limit => pathFor('ordinary', { limit })), pathFor('ordinary', { before: 'bad' })];
    cases.push(pathFor('collision', { limit: '3' }), pathFor('decimal', { limit: '3' }), pathFor('duplicate-ids', { before: duplicateCursor }), pathFor('ordinary', { limit: '2', before: cursor + '= \n' }), pathFor('ordinary', { limit: 'infinity' }), pathFor('ordinary', { limit: '0X2' }));
    save('non-object', []); save('null-record', null);
    const fallbacks = ['bound-network', 'source-only-network', 'malformed', 'unsupported', 'no-messages', 'prototype-key', 'non-object', 'null-record'].map(id => pathFor(id));
    fallbacks.push(pathFor('ordinary', { limit: '2', before: cursor + 'Ā' }), pathFor('ordinary', { limit: '0x' + '1'.repeat(65) }));
    const expected = []; for (const path of cases) expected.push(await snapshot(await call(path)));
    expect(expected[1].body).toMatchObject({ messages: [], exists: false, projectId: null });
    expect(expected[2].body).toMatchObject({ projectId: 'project-a', githubOwner: 'FixtureOwner', githubRepo: 'FixtureRepo' });
    expect(expected[4].body.messages).toHaveLength(2); expect(expected[5].status).toBe(409);
    const deferred = []; for (const path of fallbacks) deferred.push(await snapshot(await call(path)));
    expect(deferred[0].body).toMatchObject({ source: 'bot-network', network: { projectionError: 'Timed out acquiring chat-history lock for bound-network.' } });
    const auth = ['', 'unrecognized-history-bearer', workerToken, deviceToken];
    const authExpected = []; for (const bearer of auth) authExpected.push(await snapshot(await call(pathFor('ordinary'), bearer)));
    expect(authExpected[0].status).toBe(401); expect(authExpected[1].status).toBe(401);
    expect(authExpected[2].status).not.toBe(200); expect(authExpected[3].status).toBe(200);
    const writePath = pathFor('written-via-node', { workspace: repo });
    const write = (method: string, body?: unknown) => fetch(server!.origin + writePath, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const postBody = { tabId: 'written-via-node', messages: [{ id: 'persisted', role: 'user', content: 'POST exact body\n"literal"', timestamp: 123 }], repoPath: repo, title: 'Fixture title', projectId: null };
    const post = await snapshot(await write('POST', postBody)); expect(post).toMatchObject({ status: 200, body: { ok: true } });
    const persisted = JSON.parse(readFileSync(historyPath('written-via-node'), 'utf8'));
    const patch = await snapshot(await write('PATCH', { tabId: 'written-via-node', title: 'Renamed via Node' })); expect(patch.status).toBe(200);
    const deleted = await snapshot(await write('DELETE')); expect(deleted.status).toBe(405);
    // DELETE is not registered on WS today; preserve its refusal. Reset only our fixture.
    rmSync(historyPath('written-via-node'));
    await server.stop(); server = undefined;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const stderr = join(directory, 'daemon-stderr'); const wrapper = join(directory, 'capture-o8d');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderr) + '\n', { mode: 0o700 });
    server = await startSessionServer(directory, false, wrapper);
    for (const [index, path] of cases.entries()) {
      const response = await call(path); expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + path).toBe('1');
      expect(response.headers.get('server-timing')).toMatch(/^total;dur=\d+(\.\d+)?$/);
      expect(firstDifference(expected[index], await snapshot(response)), path).toBeNull();
    }
    for (const [index, path] of fallbacks.entries()) {
      const response = await call(path); expect(response.headers.get('x-o8d-native'), path).toBeNull();
      expect(await snapshot(response), path).toEqual(deferred[index]);
    }
    for (const [index, bearer] of auth.entries()) {
      const response = await call(pathFor('ordinary'), bearer);
      expect(response.headers.get('x-o8d-native')).toBe(authExpected[index].status === 200 ? '1' : null);
      expect(await snapshot(response)).toEqual(authExpected[index]);
    }
    const posted = await write('POST', postBody); expect(posted.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(posted)).toEqual(post);
    const actual = JSON.parse(readFileSync(historyPath('written-via-node'), 'utf8'));
    expect({ ...actual, savedAt: null }).toEqual({ ...persisted, savedAt: null });
    const fresh = await call(pathFor('written-via-node')); expect(fresh.headers.get('x-o8d-native')).toBe('1'); expect((await fresh.json()).messages).toEqual(postBody.messages);
    const patched = await write('PATCH', { tabId: 'written-via-node', title: 'Renamed via Node' }); expect(patched.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(patched)).toEqual(patch);
    expect((await (await call(pathFor('written-via-node'))).json()).title).toBe('Renamed via Node');
    const removed = await write('DELETE'); expect(removed.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(removed)).toEqual(deleted); expect(existsSync(historyPath('written-via-node'))).toBe(true);
    expect((await (await call(pathFor('written-via-node'))).json()).title).toBe('Renamed via Node');
    const logs = readFileSync(stderr, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    for (const secret of [token, deviceToken, workerToken]) expect(logs).not.toContain(secret);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
