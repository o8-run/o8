import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { request } from 'node:http';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';

const run = promisify(execFile);
const createPath = '/api/mobile/diff-comment', listPath = '/api/mobile/diff-comments';
const target = process.env.O8_LAUNCHER_TEST_TARGET ?? '/tmp/o8-launcher-owner-target';
const binary = process.env.O8D_TEST_BINARY ?? join(target, 'debug/o8d');
const launcher = process.env.O8_LAUNCHER_TEST_BINARY ?? join(target, 'debug/o8-launcher');
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  if (!process.env.O8D_TEST_BINARY || !process.env.O8_LAUNCHER_TEST_BINARY) {
    const { stdout } = await run('df', ['-Pk', '/']);
    if (Number(stdout.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]) < 15 * 1024 * 1024) throw Error('15 GiB free required');
  }
  if (!process.env.O8_LAUNCHER_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8-launcher/Cargo.toml', '--jobs', '1', '--target-dir', target]);
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', target]);
}, 600_000);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const device = 'fixture-diff-device-credential', worker = 'fixture-diff-worker-credential';
const packetWorker = 'fixture-diff-packet-worker', spectator = 'fixture-diff-spectator', revoked = 'fixture-diff-revoked';
type Comment = { id: string; sessionKey: string; path: string; text: string; lineNumber: number; side: 'old' | 'new'; createdAt: string; resolvedAt: string | null };
function phoneComment(value: unknown): asserts value is Comment {
  expect(value).toBeTypeOf('object');
  const item = value as Comment;
  for (const key of ['id', 'text', 'path', 'createdAt', 'sessionKey'] as const) expect(item[key]).toBeTypeOf('string');
  expect(item.lineNumber).toBeTypeOf('number');
  expect(['old', 'new']).toContain(item.side);
  expect(item.resolvedAt === null || typeof item.resolvedAt === 'string').toBe(true);
}
async function until(check: () => boolean | Promise<boolean>, reason: string, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('Diff-comments fixture timeout: ' + reason); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned quit', 15_000); }
}
it.runIf(process.platform === 'linux')('round-trips both phone comment shapes without WS, retaining TS auth refusals and fresh persistence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-diff-comments-'))), server = join(root, 'server');
  let owner: ChildProcess | undefined, stderr = '';
  try {
    await seedSessionFixture(root); await run('git', ['init', '--quiet', root]); mkdirSync(server);
    symlinkSync(join(process.cwd(), 'node_modules'), join(server, 'node_modules'), 'dir');
    const projection = hash(device) + '\nrevoked:' + hash(revoked) + '\n';
    writeFileSync(join(root, 'mobile-device-tokens'), projection);
    writeFileSync(join(root, 'worker-token'), worker);
    writeFileSync(join(root, 'worker-packet-token-hashes'), hash(packetWorker) + '\n');
    writeFileSync(join(root, 'broadcast-spectator-tokens'), hash(spectator) + '\n');
    const fixtureDb = new Database(join(root, 'cortex-ide.db'));
    try {
      const insert = fixtureDb.prepare('INSERT INTO mobile_devices (id,token_hash,identity_public_key,revoked_at) VALUES (?,?,?,?)');
      insert.run('fixture-diff-device', hash(device), 'fixture-diff-device-public-key', null);
      insert.run('fixture-diff-revoked', hash(revoked), 'fixture-diff-revoked-public-key', '2026-01-01 00:00:00');
    } finally { fixtureDb.close(); }
    const repo = process.cwd(), window = join(root, 'window'), probe = join(root, 'probe');
    writeFileSync(join(server, 'server.js'), 'throw Error("Next must remain absent");');
    writeFileSync(join(server, 'ws-server.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'tests/fixtures/launcher-diff-comments-entry.mjs')).href)});`);
    writeFileSync(window, '#!/bin/sh\necho o8-next-ready\ncat >/dev/null\n', { mode: 0o700 });
    writeFileSync(probe, `#!/bin/sh\nprintf '__O8_PATH=%s\\n__O8_NODE=%s\\n' "$PATH" '${process.execPath}'\n`, { mode: 0o700 });
    writeFileSync(join(root, 'launch.json'), JSON.stringify({ data_dir: root, server_dir: server, node: process.execPath, window, probe, api_port: 0, ws_port: 0, version: 'fixture', native_lifecycle: false, api_front_door: true, next_off: true }));
    const nodeOptions = ['--require=' + join(repo, 'scripts/next/brain-runtime.cjs'), '--import=' + pathToFileURL(join(repo, 'scripts/register-server-only-stub.mjs')).href, '--import=' + pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href].join(' ');
    owner = spawn(launcher, ['--config', join(root, 'launch.json')], { env: { PATH: process.env.PATH, HOME: root, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: nodeOptions, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), CORTEX_IDE_REVIEW_REPO_ROOT: root, O8D_BINARY: binary, O8_TTS_PYTHON: join(root, 'no-python') }, stdio: ['pipe', 'ignore', 'pipe'] });
    owner.stderr!.on('data', value => stderr += value);
    let port = 0, pid = 0;
    await until(async () => { try { port = Number(readFileSync(join(root, 'api-port'), 'utf8')); pid = (await (await fetch('http://127.0.0.1:' + port + '/health')).json()).delivery?.pid ?? 0; return pid > 0; } catch { return false; } }, 'producer ready');
    const origin = 'http://127.0.0.1:' + port, token = readFileSync(join(root, 'ws-token'), 'utf8').trim();
    writeFileSync(join(root, 'worker-packet-token-hashes'), hash(packetWorker) + '\n');
    writeFileSync(join(root, 'broadcast-spectator-tokens'), hash(spectator) + '\n');
    const call = (path: string, credential: string | null, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const input = request(origin + path, { method, headers: {
        ...(credential === null ? {} : { authorization: 'Bearer ' + credential }), 'content-type': 'application/json',
        ...(payload === undefined ? {} : { 'content-length': String(Buffer.byteLength(payload)) }), ...extra,
      } }, output => {
        const chunks: Buffer[] = []; output.on('data', chunk => chunks.push(Buffer.from(chunk)));
        output.on('error', reject); output.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(output.headers)) if (value !== undefined) {
            for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          }
          resolve(new Response(Buffer.concat(chunks), { status: output.statusCode!, headers }));
        });
      });
      input.on('error', reject); input.setTimeout(15_000, () => input.destroy(Error('Fixture request deadline'))); input.end(payload);
    });
    const unauthorized = { error: 'Unauthorized', detail: 'This endpoint is restricted to local o8 clients. Requests from other origins must present a valid bearer token.' };
    const refusals: Array<[string | null, number, unknown]> = [
      [null, 401, unauthorized], ['fixture-wrong', 401, unauthorized],
      [worker, 403, { error: 'Worker token is not authorized for this endpoint.' }],
      [packetWorker, 403, { error: 'Worker token is not authorized for this endpoint.' }],
      ['o8ro_fixture', 403, { error: 'Read-only worker has no API capability.' }],
      [spectator, 403, { error: 'Spectator token is not authorized for this endpoint.' }],
      [revoked, 401, { error: 'Unauthorized', code: 'device_revoked' }],
    ];
    const auth = async () => {
      for (const [index, [credential, status, expected]] of refusals.entries()) for (const [path, method] of [[listPath + '?sessionKey=fixture-session', 'GET'], [createPath, 'POST']]) {
        const answer = await call(path, credential, method, method === 'POST' ? {} : undefined);
        expect(answer.status, 'auth case ' + index + ' ' + method).toBe(status); expect(await answer.json()).toEqual(expected);
      }
    };
    await auth(); // Current-main public TS gate is the red-run auth oracle.
    for (const credential of [token, device]) {
      const initial = await call(listPath + '?sessionKey=fixture-session', credential);
      expect(initial.status).toBe(200); expect(await initial.json()).toEqual({ comments: [] });
    }
    writeFileSync(join(root, 'hold-ws-start'), 'hold');
    process.kill(JSON.parse(readFileSync(join(root, 'launcher-ws.json'), 'utf8')).pid, 'SIGKILL');
    await until(() => readFileSync(join(root, 'ws-starts'), 'utf8').trim().split('\n').length >= 2, 'replacement producer held');
    expect(JSON.parse(readFileSync(join(root, 'launcher-o8d.json'), 'utf8')).pid).toBe(pid);
    expect((await call('/api/panel/ws-info', token)).status).toBe(200);
    const created: Comment[] = [];
    for (const [side, credential, lineNumber] of [['old', device, 12], ['new', token, 0]] as const) {
      const input = { sessionKey: ' fixture-session ', path: ' src/' + side + '.ts ', lineNumber, side, text: ' ' + side + '-side note ' };
      const answer = await call(createPath, credential, 'POST', input);
      expect(answer.status, 'Native diff-comment create was not reached with WS stopped').toBe(200);
      expect(answer.headers.get('x-o8d-native')).toBe('1');
      const body = await answer.json(); phoneComment(body.comment);
      expect(body.comment).toEqual({ id: expect.any(String), sessionKey: 'fixture-session', path: 'src/' + side + '.ts', lineNumber, side, text: side + '-side note', createdAt: expect.any(String), resolvedAt: null });
      created.push(body.comment);
      const listed = await call(listPath + '?sessionKey=fixture-session', device);
      expect(listed.status).toBe(200); expect(listed.headers.get('x-o8d-native')).toBe('1');
      const list = (await listed.json()).comments;
      for (const item of list) phoneComment(item); // No silently discarded parser entries.
      for (const item of created) expect(list.find((candidate: Comment) => candidate.id === item.id)).toEqual(item);
      expect(list).toEqual([...created].reverse());
    }
    await auth(); // Same byte-level JSON error objects with the producer absent.
    for (const input of [{}, { sessionKey: 'fixture-session', path: 'a.ts', text: 'note', lineNumber: -1 }, { sessionKey: 'fixture-session', path: 'a.ts', text: 'note', lineNumber: 1.5 }]) {
      const refused = await call(createPath, device, 'POST', input);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'sessionKey, path, text, and a valid lineNumber are required' });
    }
    const invalidJson = await fetch(origin + createPath, { method: 'POST', headers: { authorization: 'Bearer ' + device, 'content-type': 'application/json' }, body: '{' });
    expect(invalidJson.status).toBe(400); expect(await invalidJson.json()).toEqual({ error: 'Invalid JSON' });
    const missing = await call(listPath, device);
    expect(missing.status).toBe(400); expect(await missing.json()).toEqual({ error: 'sessionKey required' });
    writeFileSync(join(root, 'mobile-device-tokens'), 'revoked:' + hash(device) + '\n');
    const removed = await call(listPath + '?sessionKey=fixture-session', device);
    expect(removed.status).toBe(401); expect(await removed.json()).toEqual({ error: 'Unauthorized', code: 'device_revoked' });
    writeFileSync(join(root, 'mobile-device-tokens'), 'unavailable\n');
    const unavailable = await call(listPath + '?sessionKey=fixture-session', device);
    expect(unavailable.status).toBe(503); expect(unavailable.headers.get('retry-after')).toBe('2');
    expect(await unavailable.json()).toEqual({ error: 'Authentication storage unavailable', code: 'auth_unavailable', retryable: true });
    writeFileSync(join(root, 'mobile-device-tokens'), projection);
    for (const [extra, method, status, expected] of [
      [{ host: 'foreign.invalid' }, 'GET', 421, { error: 'Misdirected Request' }],
      [{ origin: 'https://foreign.invalid' }, 'POST', 403, { error: 'Origin is not allowed' }],
    ] as const) {
      const refused = await call(method === 'GET' ? listPath + '?sessionKey=fixture-session' : createPath, device, method, method === 'POST' ? {} : undefined, extra);
      expect(refused.status).toBe(status); expect(await refused.json()).toEqual(expected);
    }
    // The saved LAN policy is read on each request, without changing the
    // fixture listener's loopback binding or touching the installed profile.
    writeFileSync(join(root, 'phone-network'), 'on\n');
    expect((await call(listPath + '?sessionKey=fixture-session', device, 'GET', undefined, { host: '192.0.2.1:' + port })).status).toBe(200);
    writeFileSync(join(root, 'phone-network'), 'off\n');
    expect((await call(listPath + '?sessionKey=fixture-session', device, 'GET', undefined, { host: '192.0.2.1:' + port })).status).toBe(421);
    const oracle = join(root, 'ts-list.json');
    await run(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'tests/fixtures/o8d-diff-comments-reference.mts', oracle], {
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db') },
    });
    const listed = await call(listPath + '?sessionKey=fixture-session', token);
    expect({ status: listed.status, body: await listed.json() }).toEqual(JSON.parse(readFileSync(oracle, 'utf8')));
    const db = new Database(join(root, 'cortex-ide.db'), { readonly: true });
    try { expect(db.prepare('SELECT count(*) n FROM mobile_diff_comments').get()).toEqual({ n: 2 }); } finally { db.close(); }
    expect(existsSync(join(root, 'diff-comments-node-calls.jsonl'))).toBe(false);
    const logs = readFileSync(join(root, 'logs/o8d.log'), 'utf8') + readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8') + stderr;
    for (const secret of [token, device, worker, packetWorker, spectator, revoked]) expect(logs.includes(secret)).toBe(false);
  } finally { await stop(owner); rmSync(root, { recursive: true, force: true }); }
}, 240_000);

it('preserves classic create/resolve and refuses every Node product comment writer', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-diff-comment-writers-'))), result = join(root, 'result.json');
  try {
    await seedSessionFixture(root);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'), O8_API_FRONT_DOOR: '0' };
    const args = ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'tests/fixtures/o8d-diff-comments-reference.mts', result];
    await run(process.execPath, [...args, '--classic'], { env });
    const classic = JSON.parse(readFileSync(result, 'utf8'));
    expect(classic.body.comments).toHaveLength(1); phoneComment(classic.body.comments[0]);
    expect(classic.body.comments[0].resolvedAt).toBeTypeOf('string');
    await run(process.execPath, [...args, '--check-writers'], { env: { ...env, O8_API_FRONT_DOOR: '1' } });
    expect(JSON.parse(readFileSync(result, 'utf8')).fenced).toEqual({
      errors: ['Diff-comment writes require the native mobile transport.', 'Diff-comment writes require the native mobile transport.'], before: { n: 1 }, after: { n: 1 },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
