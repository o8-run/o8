import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';
const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug/o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['test', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir, '--test', 'mobile_lane_overlays']);
}, 900_000);
const route = '/api/mobile/history';
const pathFor = (id: string, params: Record<string, string> = {}) => route + '?' + new URLSearchParams({ sessionKey: 'llm-chat:' + id, ...params });
async function snapshot(response: Response) { return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> }; }
async function typescript(origin: string, token: string, path: string) {
  return new Promise<Awaited<ReturnType<typeof snapshot>>>((resolve, reject) => {
    const req = httpRequest(origin + path, { headers: { authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' } }, res => {
      expect(res.headers['x-o8d-native']).toBeUndefined(); const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'] ? String(res.headers['content-type']) : null, cache: res.headers['cache-control'] ? String(res.headers['cache-control']) : null, body: JSON.parse(Buffer.concat(chunks).toString()) })); res.once('error', reject);
    }); req.once('error', reject); req.end();
  });
}
it.skipIf(process.platform !== 'linux')('merges persisted lane huddles and steers through the public socket with exact ordering, paging and fail-closed fallbacks', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-phone-overlays-'))); const oldTZ = process.env.TZ; process.env.TZ = 'America/New_York';
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory); const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const history = join(directory, 'chat-history'); mkdirSync(history, { recursive: true });
    const save = (id: string, messages: unknown[]) => writeFileSync(join(history, id + '.json'), JSON.stringify({ messages }));
    const midnight = '2026-02-01T05:00:00.000Z', morning = '2026-02-01T14:05:00.000Z', afternoon = '2026-02-01T19:40:00.000Z';
    // JSON's persisted spelling of non-finite numeric timestamps is null.
    save('overlays', [{ id: 'nonfinite', role: 'user', content: 'nonfinite first', timestamp: Number.NaN }, { id: 'missing-time', role: 'assistant', content: 'missing timestamp' }, { id: 'duplicate', role: 'user', content: 'old duplicate', timestamp: Date.parse(morning) }, { id: 'duplicate', role: 'assistant', content: 'last duplicate wins', timestamp: Date.parse(morning) }, { id: 'huddle-1', role: 'user', content: 'overlay replaces this', timestamp: 1 }, { id: 'tie', role: 'assistant', content: 'tie stays before overlay', timestamp: Date.parse(afternoon) }]);
    for (const id of ['ordered', 'ambiguous', 'unknown', 'payload', 'receipt', 'shape', 'timestamp', 'window', 'correlation']) save(id, [{ id: 'base', role: 'user', content: id }]);
    const db = new Database(join(directory, 'cortex-ide.db'));
    const lane = (id: string, thread: string, created = '2026-01-01') => db.prepare(`INSERT INTO lanes (id,label,repo_path,branch,base_branch,runtime,session_key,status,ownership,created_at,updated_at) VALUES (?, 'Overlay fixture', ?, 'fixture','HEAD','claude',?,'archived','attached',?,?)`).run(id, directory, 'llm-chat:' + thread, created, created);
    const event = (id: string, laneId: string, verb: string, payload: unknown, timestamp: string) => db.prepare('INSERT INTO lane_events (id,lane_id,verb,actor,payload_json,timestamp) VALUES (?,?,?,\'orchestrator\',?,?)').run(id, laneId, verb, JSON.stringify(payload), timestamp);
    try { db.transaction(() => {
      lane('overlay-lane','overlays');
      event('huddle','overlay-lane','agent_report',{ event: 'huddle', message: '  Plan posted  ' },midnight);
      event('intent','overlay-lane','steered_packet',{ message: 'Correction', source: 'Operator' },morning);
      event('failure','overlay-lane','steer_failed',{ steerEventId: 'intent', message: 'Correction', note: 'Retry refused', stderrHead: 'Owned ARTIFACT ADMISSION accounting refused' },afternoon);
      event('queued','overlay-lane','steered_packet',{ message: 'Queued intent', deliveryState: 'queued' },afternoon);
      event('receipt-failed','overlay-lane','steer_delivery',{ steerEventId: 'queued', state: 'failed', note: 'Transport stopped' },'2026-02-01T19:41:00.000Z');
      event('standalone','overlay-lane','steer_failed',{ text: 'Unmatched correction', note: 'Inspect the worker', source: 'Operator' },'2026-02-01T19:42:00.000Z');
      lane('later-lane','ordered','2026-03-01'); lane('first-lane','ordered','2026-01-01');
      event('later-huddle','later-lane','agent_report',{ event: 'huddle', message: 'later lane excluded' },morning); event('first-huddle','first-lane','agent_report',{ event: 'huddle', message: 'first lane selected' },morning);
      lane('ambiguous-a','ambiguous'); lane('ambiguous-b','ambiguous'); event('ambiguous-huddle','ambiguous-a','agent_report',{ event: 'huddle', message: 'TS chooses its first lane' },morning);
      for (const id of ['unknown','payload','receipt','shape','timestamp','window','correlation']) lane(id + '-lane',id);
      event('unknown-kind','unknown-lane','future_overlay_kind',{ message: 'unknown' },morning);
      event('bad-payload','payload-lane','agent_report',{ event: 'huddle' },morning); db.prepare("UPDATE lane_events SET payload_json = '{broken' WHERE id = 'bad-payload'").run();
      event('bad-receipt-intent','receipt-lane','steered_packet',{ message: 'receipt', deliveryState: 'queued' },morning);
      event('bad-receipt','receipt-lane','steer_delivery',{ steerEventId: 'bad-receipt-intent', state: 'delivered' },afternoon); db.prepare("UPDATE lane_events SET payload_json = '{broken' WHERE id = 'bad-receipt'").run();
      event('bad-shape','shape-lane','steered_packet',{ message: { unsupported: true } },morning);
      event('bad-time','timestamp-lane','agent_report',{ event: 'huddle', message: 'invalid TS timestamp' },'not-a-date');
      event('old-queued','window-lane','steered_packet',{ message: 'Old queued survives recent window', deliveryState: 'queued' },midnight);
      db.prepare("UPDATE lane_events SET actor = 'user' WHERE id = 'old-queued'").run();
      event('old-delivery','window-lane','steer_delivery',{ steerEventId: 'old-queued', state: 'delivered', note: 'Delivered newest receipt' },morning);
      event('correlate-a','correlation-lane','steered_packet',{ message: 'client mutation intent', clientMutationId: 'client-a' },morning);
      event('correlate-a-failed','correlation-lane','steer_failed',{ message: 'different failure text', clientMutationId: 'client-a', note: 'client mutation note' },afternoon);
      event('correlate-b','correlation-lane','steered_packet',{ message: 'same message' },'2026-02-01T14:06:00.000Z');
      event('correlate-b-failed','correlation-lane','steer_failed',{ message: 'same message', note: 'timestamp and message note' },'2026-02-01T19:41:00.000Z');
      event('note-only','correlation-lane','steer_failed',{ note: 'ＡＲＴＩＦＡＣＴ stays literal' },'2026-02-01T19:42:00.000Z');
      event('huddle-tie-a','correlation-lane','agent_report',{ event: 'huddle', message: 'tie A' },midnight);
      event('huddle-tie-b','correlation-lane','agent_report',{ event: 'huddle', message: 'tie B' },midnight);
      for (let index = 0; index < 510; index++) event('window-neutral-' + index,'window-lane','open_lane',{},new Date(Date.parse(afternoon) + index).toISOString());
    })(); } finally { db.close(); }
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext(); server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string) => fetch(server!.origin + path, { headers: { authorization: `Bearer ${token}` } });
    const page = await snapshot(await call(pathFor('overlays', { page: '1', limit: '3' }))); const cursor = (page.body.page as { beforeCursor: string }).beforeCursor;
    const cases = [pathFor('overlays'), pathFor('overlays', { page: '1' }), pathFor('overlays', { page: '1', limit: '3' }), pathFor('overlays', { page: '1', limit: '3', before: cursor }), pathFor('ordered', { page: '1' }), pathFor('window', { page: '1' }), pathFor('correlation', { page: '1' })];
    const expected = []; for (const path of cases) expected.push(await snapshot(await call(path)));
    const transcript = expected[1].body.transcript as { id: string; text: string; timestampLabel: string }[];
    expect(transcript.filter(row => row.id === 'duplicate')).toEqual([expect.objectContaining({ text: 'last duplicate wins' })]);
    expect(transcript.find(row => row.id === 'huddle-1')).toMatchObject({ text: 'Huddling — plan posted\n\nPlan posted', timestampLabel: '12:00 AM' });
    expect(transcript.find(row => row.id === 'steer-1')).toMatchObject({ timestampLabel: '9:05 AM', text: expect.stringContaining('The worker could not start another turn.') });
    expect(transcript.find(row => row.id === 'steer-2')).toMatchObject({ timestampLabel: '2:40 PM', text: 'Steer failed to start · 2:40 PM\n\nQueued intent\n\nTransport stopped' });
    expect(transcript.findIndex(row => row.id === 'tie')).toBeLessThan(transcript.findIndex(row => row.id === 'steer-2'));
    expect(transcript.slice(0,2).map(row => row.id)).toEqual(['nonfinite','missing-time']);
    expect((expected[4].body.transcript as { text: string }[]).map(row => row.text).join('\n')).toContain('first lane selected');
    expect((expected[5].body.transcript as { text: string }[]).map(row => row.text).join('\n')).toContain('Old queued survives recent window');
    expect((expected[5].body.transcript as { text: string }[]).find(row => row.text.includes('Old queued'))?.text).toMatch(/^orchestrator ·/);
    const correlated = expected[6].body.transcript as { text: string }[];
    expect(correlated.some(row => row.text.includes('client mutation intent\n\nclient mutation note'))).toBe(true);
    expect(correlated.some(row => row.text.includes('same message\n\ntimestamp and message note'))).toBe(true);
    const noteOnly = correlated.find(row => row.text.includes('ＡＲＴＩＦＡＣＴ'))!.text;
    expect(noteOnly.split('ＡＲＴＩＦＡＣＴ')).toHaveLength(2); expect(noteOnly).not.toContain('Inspect its retained session');
    const fallbackPaths = ['ambiguous','unknown','payload','receipt','shape','timestamp'].map(id => pathFor(id,{ page: '1' })); const fallbackExpected = []; for (const path of fallbackPaths) fallbackExpected.push(await snapshot(await call(path)));
    await server.stop(); server = undefined;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'"; const stderr = join(directory,'daemon-stderr'); const wrapper = join(directory,'capture-o8d');
    writeFileSync(wrapper,'#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderr) + '\n',{ mode: 0o700 }); server = await startSessionServer(directory,false,wrapper);
    for (const [index,path] of cases.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'),'Native route was not reached: ' + path).toBe('1'); expect(firstDifference(expected[index],await snapshot(response)),path).toBeNull(); }
    for (const [index,path] of fallbackPaths.entries()) { const response = await call(path); expect(response.headers.get('x-o8d-native'),path).toBeNull(); expect(await snapshot(response),path).toEqual(fallbackExpected[index]); }
    await promisify(execFile)(process.execPath,['--import=./scripts/register-server-only-stub.mjs','--import=tsx','tests/fixtures/o8d-lane-overlay-write.ts','overlay-lane'],{ env: { ...process.env,O8_DATA_DIR: undefined,CORTEX_IDE_DATA_DIR: directory,CORTEX_IDE_DB_PATH: join(directory,'cortex-ide.db') } });
    const livePath = pathFor('overlays',{ page: '1' }); const liveExpected = await typescript(server.origin,token,livePath); const live = await call(livePath); expect(live.headers.get('x-o8d-native')).toBe('1'); const actual = await snapshot(live); expect(actual).toEqual(liveExpected); expect((actual.body.transcript as { text: string }[]).some(row => row.text.includes('Fresh Node steer'))).toBe(true);
    // COUNT and MAX(rowid) stay unchanged, so this also witnesses that the TS
    // path does not consume the nearby versioned getRecentLaneEvents cache.
    const updated = new Database(join(directory,'cortex-ide.db'));
    try { updated.prepare('UPDATE lane_events SET payload_json = ? WHERE id = ?').run(JSON.stringify({ event: 'huddle', message: 'Fresh in-place huddle' }),'huddle'); } finally { updated.close(); }
    const editedExpected = await typescript(server.origin,token,livePath); const edited = await call(livePath);
    expect(edited.headers.get('x-o8d-native')).toBe('1'); const editedBody = await snapshot(edited); expect(editedBody).toEqual(editedExpected); expect((editedBody.body.transcript as { text: string }[]).some(row => row.text.includes('Fresh in-place huddle'))).toBe(true);
    const broken = new Database(join(directory,'cortex-ide.db')); try { broken.exec('ALTER TABLE lane_events RENAME COLUMN payload_json TO unavailable_payload_json'); const expected = await typescript(server.origin,token,livePath); const response = await call(livePath); expect(response.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(response)).toEqual(expected); } finally { broken.exec('ALTER TABLE lane_events RENAME COLUMN unavailable_payload_json TO payload_json'); broken.close(); }
    expect(readFileSync(stderr,'utf8') + readFileSync(join(directory,'o8d-request-counts.jsonl'),'utf8')).not.toContain(token);
  } finally { await server?.stop(); if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; rmSync(directory,{ recursive: true,force: true }); }
},180_000);
