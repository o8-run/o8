import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { ensureMobileDeviceSchema } from '@/lib/db/mobile-device-schema';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';
const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug/o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['test', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir, '--test', 'mobile_history_reads']);
}, 900_000);
const route = '/api/mobile/history';
const pathFor = (sessionKey: string, params: Record<string, string> = {}) => route + '?' + new URLSearchParams({ sessionKey, ...params });
async function snapshot(response: Response) { return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> }; }

// Unsupported GET framing reaches the same canonical TS producer for fresh
// schema-failure parity, without a second writer or a running Next listener.
async function typescript(origin: string, token: string, path: string) {
  return new Promise<Awaited<ReturnType<typeof snapshot>>>((resolve, reject) => {
    const request = httpRequest(origin + path, { method: 'GET', headers: { authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' } }, response => {
      expect(response.headers['x-o8d-native']).toBeUndefined(); const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'] ? String(response.headers['content-type']) : null, cache: response.headers['cache-control'] ? String(response.headers['cache-control']) : null, body: JSON.parse(Buffer.concat(chunks).toString()) })); response.once('error', reject);
    }); request.once('error', reject); request.end();
  });
}

it('the real mobile loader performs no projection writes for an ordinary admitted tab with its lock held', async () => {
  const { getSqlite, closeDb } = await import('@/lib/db');
  const { getCanonicalChatHistoryPath } = await import('@/lib/llm/chat-history-store');
  const { nativeChatHistoryAllowed, nativeMobileHistoryAllowed } = await import('@/lib/ws-server/native-chat-history-admission');
  const { loadMobileLlmChatHistory } = await import('@/lib/llm/mobile-llm-chat');
  const { recordNetworkProjectionHealth, networkProjectionError } = await import('@/lib/bots/network-health');
  const db = getSqlite(); const id = 'mobile-projection-noop'; const file = getCanonicalChatHistoryPath(id);
  mkdirSync(join(file, '..'), { recursive: true });
  const bytes = JSON.stringify({ messages: [{ id: 'turn', role: 'user', content: 'ordinary', timestamp: 0 }] });
  try {
    writeFileSync(file, bytes); writeFileSync(file + '.lock', 'held-noop-lock');
    recordNetworkProjectionHealth(id, new Error('prior projection health'));
    const before = statSync(file); const lock = statSync(file + '.lock');
    const dbState = () => [db.prepare('SELECT total_changes() AS n').get(), db.pragma('schema_version')]; const initial = dbState();
    expect(nativeChatHistoryAllowed(id)).toBe(true); expect(nativeMobileHistoryAllowed('llm-chat:' + id)).toBe(true);
    expect(loadMobileLlmChatHistory('llm-chat:' + id)).toEqual({ sessionKey: 'llm-chat:' + id, transcript: [{ id: 'turn', role: 'user', text: 'ordinary', type: 'message', timestamp: 0, timestampLabel: '' }] });
    expect(readFileSync(file, 'utf8')).toBe(bytes); expect(statSync(file)).toMatchObject({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    expect(readFileSync(file + '.lock', 'utf8')).toBe('held-noop-lock'); expect(statSync(file + '.lock')).toMatchObject({ ino: lock.ino, size: lock.size, mtimeMs: lock.mtimeMs, ctimeMs: lock.ctimeMs });
    expect(dbState()).toEqual(initial); expect(networkProjectionError(id)).toBe('prior projection health');
  } finally { recordNetworkProjectionHealth(id, null); closeDb(); rmSync(file, { force: true }); rmSync(file + '.lock', { force: true }); }
});

it.skipIf(process.platform !== 'linux')('serves admitted phone transcripts through the public o8d socket with exact mobile mapping, paging and Node fallbacks', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-mobile-history-'))); let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory); const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const device = 'e8'.repeat(32); const worker = 'mobile-history-fixture-worker'; const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    writeFileSync(join(directory, 'mobile-device-tokens'), hash(device) + '\n'); writeFileSync(join(directory, 'worker-token'), worker);
    const history = join(directory, 'chat-history'); mkdirSync(history, { recursive: true });
    const file = (id: string) => join(history, id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    const save = (id: string, record: unknown) => writeFileSync(file(id), JSON.stringify(record));
    const receipt = { leadModel: 'fixture', effort: 'high', mode: 'solo', workers: [{ packetId: 'old', runtime: 'codex', model: 'old' }, { packetId: 'same', runtime: 'claude', model: 'old' }] };
    const messages = Array.from({ length: 105 }, (_, index) => ({ id: 'm-' + index, role: index % 2 ? 'assistant' : 'user', content: 'turn ' + index, timestamp: 1700000000000 + index * 60_000 }));
    save('ordinary', { messages });
    save('rich', { messages: [{ id: 'partial', role: 'assistant', content: 'hidden partial', isPartial: true }, { id: 'truthy-partial', role: 'assistant', content: 'also hidden', isPartial: 'yes' }, { id: 'user', role: 'user', content: 'question', timestamp: 0, mentions: [{ kind: 'file', path: 'src/main.rs', label: 'main.rs' }], steerAnchor: { messageId: 'anchor' } }, { id: 'assistant', role: 'assistant', content: 'reply', timestamp: 1700000000000, receipt, costUsd: 0.000001, thinking: 'detail', thinkingDurationMs: 12, sources: [{ title: 'source', path: 'file' }], toolCalls: [{ id: 'tool-1', name: 'read', args: { path: 'file', nested: { value: 1 } }, status: 'done', result: 'exact output', preview: 'preview', startedAt: 2, finishedAt: 3, launchLink: null }], media: [{ type: 'image', path: 'fixture.png' }] }, { role: 'assistant', content: 'legacy', compaction: { summary: 'summary' }, timestampLabel: 'saved clock' }], pendingTurnWorkers: { assistant: [{ packetId: 'same', runtime: 'codex', model: 'new' }, { packetId: 'new', runtime: 'claude', model: 'new' }] } });
    save('source-network', { source: 'bot-network', messages: [{ id: 'network', role: 'assistant', content: 'projected source' }] });
    save('bound-network', { source: 'bot-network', messages: [{ id: 'network', role: 'assistant', content: 'locked projected record' }] }); writeFileSync(file('bound-network') + '.lock', 'fixture-held-lock');
    for (const id of ['lane']) save(id, { messages: [{ id: 'turn', role: 'user', content: id + ' ordinary turn', timestamp: 1700000000000 }] });
    writeFileSync(file('malformed'), '{"messages":['); save('bad-tool', { messages: [{ id: 'tool', role: 'assistant', content: '', toolCalls: 'unsupported' }] });
    save('bad-pending', { messages: [{ id: 'constructor', role: 'assistant', content: 'prototype worker id', receipt: {} }], pendingTurnWorkers: { ordinary: [] } });
    const db = new Database(join(directory, 'cortex-ide.db'));
    try {
      ensureMobileDeviceSchema(db); db.prepare('INSERT INTO mobile_devices (id,token_hash,identity_public_key) VALUES (?,?,?)').run('history-device', hash(device), 'fixture-identity');
      db.prepare('INSERT INTO bot_network_threads (thread_id,repo_path,conversation_id,participants_json,title,created_at) VALUES (?,?,NULL,?,?,?)').run('bound-network', directory, '[]', 'Network fixture', '2026-01-01T00:00:00.000Z');
      db.prepare(`INSERT INTO lanes (id,label,repo_path,worktree_path,branch,base_branch,runtime,session_key,status,ownership,created_at,updated_at) VALUES ('mobile-lane','Mobile fixture',?,?,'fixture','HEAD','claude','llm-chat:lane','running','attached','2026-01-01','2026-01-01')`).run(directory, directory);
    } finally { db.close(); }
    mkdirSync(join(directory, 'subagent-transcripts')); writeFileSync(join(directory, 'subagent-transcripts/fixture.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'subagent-turn', timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'text', text: 'subagent stays on Node' }] } }) + '\n');
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext(); server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, bearer = token) => { utimesSync(file('bound-network') + '.lock', new Date(), new Date()); return fetch(server!.origin + path, { headers: { authorization: `Bearer ${bearer}` } }); };
    const first = await snapshot(await call(pathFor('llm-chat:ordinary', { page: '1' }))); const cursor = (first.body.page as { beforeCursor: string }).beforeCursor;
    const stale = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), revision: 'stale' })).toString('base64url');
    const cases = [pathFor('llm-chat:ordinary'), pathFor('llm-chat:ordinary', { page: '1' }), pathFor('llm-chat:ordinary', { page: '1', before: cursor }), pathFor('llm-chat:ordinary', { page: '1', before: stale }), pathFor('llm-chat:rich'), pathFor('llm-chat:rich', { page: '1' }), pathFor('llm-chat:missing'), pathFor('llm-chat:missing', { page: '1' }), ...['', '0', '2.5', 'bad', '0x2', '1000'].map(limit => pathFor('llm-chat:ordinary', { limit })), pathFor(' \ufeffllm-chat:rich\u00a0 ', { page: '1', limit: '2' })];
    cases.push(pathFor('llm-chat:lane'), pathFor('llm-chat:lane', { page: '1' }));
    const fallbacks = ['llm-chat:source-network', 'llm-chat:bound-network', 'subagent:fixture', 'codex-owned:unknown', 'llm-chat:malformed', 'llm-chat:bad-tool', 'llm-chat:bad-pending'].flatMap(key => [pathFor(key), pathFor(key, { page: '1' })]);
    const expected = []; for (const path of cases) expected.push(await snapshot(await call(path)));
    expect(expected[0].body.transcript).toHaveLength(6); expect(expected[1].body.transcript).toHaveLength(100); expect(expected[2].body.transcript).toHaveLength(5); expect(expected[3].status).toBe(409); expect(expected[3].body.ok).toBe(false);
    expect((expected[5].body.transcript as { id: string }[]).some(row => row.id === 'partial')).toBe(false);
    const deferred = []; for (const path of fallbacks) deferred.push(await snapshot(await call(path)));
    const auth = ['', 'invalid-phone-history', worker, device]; const authExpected = []; for (const bearer of auth) authExpected.push(await snapshot(await call(cases[0], bearer)));
    expect(authExpected[0].status).toBe(401); expect(authExpected[2].status).not.toBe(200); expect(authExpected[3].status).toBe(200);
    await server.stop(); server = undefined;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'"; const stderr = join(directory, 'daemon-stderr'); const wrapper = join(directory, 'capture-o8d');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderr) + '\n', { mode: 0o700 }); server = await startSessionServer(directory, false, wrapper);
    for (const [index, path] of cases.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + path).toBe('1'); expect(firstDifference(expected[index], await snapshot(response)), path).toBeNull(); }
    for (const [index, path] of fallbacks.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'), path).toBeNull(); expect(await snapshot(response), path).toEqual(deferred[index]); }
    for (const [index, bearer] of auth.entries()) { const response = await call(cases[0], bearer); expect(response.headers.get('x-o8d-native')).toBe(authExpected[index].status === 200 ? '1' : null); expect(await snapshot(response)).toEqual(authExpected[index]); }
    const posted = await fetch(server.origin + '/api/v2/chat-history?' + new URLSearchParams({ workspace: directory }), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tabId: 'live-write', repoPath: directory, messages: [{ id: 'fresh', role: 'user', content: 'fresh Node write', timestamp: 0 }] }) });
    expect(posted.headers.get('x-o8d-native')).toBeNull(); expect(await posted.json()).toEqual({ ok: true }); expect(existsSync(file('live-write'))).toBe(true);
    const fresh = await call(pathFor('llm-chat:live-write')); expect(fresh.headers.get('x-o8d-native')).toBe('1'); expect((await fresh.json()).transcript).toEqual([{ id: 'fresh', role: 'user', text: 'fresh Node write', timestamp: 0, timestampLabel: '', type: 'message' }]);
    const mutate = (sql: string) => { const connection = new Database(join(directory, 'cortex-ide.db')); try { connection.exec(sql); } finally { connection.close(); } };
    const compareFallback = async (path: string) => {
      const expected = await typescript(server!.origin, token, path); const response = await call(path);
      expect(response.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(response)).toEqual(expected);
    };
    mutate('ALTER TABLE lanes RENAME TO unavailable_lanes');
    try { await compareFallback(cases[0]); await compareFallback(cases[1]); } finally { mutate('ALTER TABLE unavailable_lanes RENAME TO lanes'); }
    const logs = readFileSync(stderr, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8'); for (const secret of [token, device, worker]) expect(logs).not.toContain(secret);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
