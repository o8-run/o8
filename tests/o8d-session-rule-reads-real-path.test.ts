import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';
const route = '/api/orchestrator/session-rules';
const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/session-reads/debug/o8d');
const clientBinary = process.env.O8_SESSION_RULE_CLIENT_TEST_BINARY;
const run = promisify(execFile);
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', 'crates/o8d/target/session-reads']);
}, 300_000);
async function raw(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.text() };
}
function classic(origin: string, path: string, token: string) {
  return new Promise<Awaited<ReturnType<typeof raw>>>((resolve, reject) => {
    const req = request(origin + path, { headers: { authorization: 'Bearer ' + token, 'transfer-encoding': 'chunked' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'] ?? null, cache: res.headers['cache-control'] ?? null, body }));
    }); req.on('error', reject); req.end();
  });
}
async function seed(root: string, name: string) {
  await run(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/' + name], { env: { ...process.env, O8_API_FRONT_DOOR: undefined, O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db') } });
}
it('operator reads match TypeScript, preserve worker scope, and survive Node stop/restart with the composer Client', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-rule-reads-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let daemon: ReturnType<typeof spawn> | undefined; let stderr = '';
  try {
    await seedSessionFixture(root); await seed(root, 'o8d-session-rule-read-seed.ts'); await seed(root, 'o8d-prompt-auth-seed.ts');
    await seed(root, 'o8d-session-rule-worker-read.ts');
    const workerReplies = JSON.parse(readFileSync(join(root, 'session-rule-worker-replies.json'), 'utf8'));
    expect(workerReplies.map((reply: { status: number }) => reply.status)).toEqual([200, 403, 400]);
    expect(workerReplies[0].body.result.rules.map((rule: { id: string }) => rule.id)).toEqual(['fixture-rule-first', 'fixture-rule-second']);
    server = await startParityReference({ directory: root, nativeHttp: true, productFrontDoor: true, o8d: true, nativeSessionReads: 'default', binary }); await server.stopNext();
    let origin = server.url.replace('ws:', 'http:').replace('/ws', ''); const token = server.token;
    const headers = { authorization: 'Bearer ' + token };
    for (const suffix of ['', '?threadId=  ', '?threadId=thoughts-review', '?threadId=thoughts-other', '?threadId=missing', '?threadId=%20thoughts-review%20&threadId=thoughts-other']) {
      const expected = await classic(origin, route + suffix, token); const response = await fetch(origin + route + suffix, { headers });
      expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + route + suffix).toBe('1');
      const actual = await raw(response); expect({ ...actual, body: JSON.parse(actual.body) }).toEqual({ ...expected, body: JSON.parse(expected.body) });
    }
    const response = await fetch(origin + route + '?threadId=thoughts-review', { headers });
    expect((await response.json()).result.rules.map((rule: { id: string }) => rule.id)).toEqual(['fixture-rule-first', 'fixture-rule-second']);
    const worker = readFileSync(join(root, 'session-rule-worker-token'), 'utf8');
    const credentials = JSON.parse(readFileSync(join(root, 'prompt-credentials.json'), 'utf8')) as Record<string, string>;
    for (const bearer of ['', 'wrong', worker, ...Object.values(credentials)]) for (const thread of ['thoughts-review', 'thoughts-other']) {
      const path = route + '?threadId=' + thread; const expected = await classic(origin, path, bearer); const got = await fetch(origin + path, { headers: { authorization: 'Bearer ' + bearer } });
      expect(got.headers.get('x-o8d-native')).toBeNull(); expect(await raw(got)).toEqual(expected);
      expect(expected.status).toBeGreaterThanOrEqual(400);
      if (bearer === worker) { expect(expected.status, expected.body).toBe(403); expect(JSON.parse(expected.body).error).toBe('Worker token is not authorized for this endpoint.'); }
    }
    const forgedPath = route + '?threadId=thoughts-other';
    const forged = await fetch(origin + forgedPath, { headers: { authorization: 'Bearer ' + worker, 'x-o8d-defaults-context': Buffer.from(JSON.stringify({ sessionRuleReadAuthority: true })).toString('base64') } });
    expect(forged.headers.get('x-o8d-native')).toBeNull(); expect(forged.status).toBe(403); expect(await raw(forged)).toEqual(await classic(origin, forgedPath, worker));
    // Any SQL/schema failure defers the whole response to the real TS error handler.
    const db = new Database(join(root, 'cortex-ide.db')); db.exec('ALTER TABLE session_rules RENAME TO fixture_saved_rules');
    const failedPath = route + '?threadId=thoughts-review'; const expectedFailure = await classic(origin, failedPath, token); const failure = await fetch(origin + failedPath, { headers });
    expect(expectedFailure.status).toBe(500); expect(failure.headers.get('x-o8d-native')).toBeNull(); expect(await raw(failure)).toEqual(expectedFailure);
    db.exec('ALTER TABLE fixture_saved_rules RENAME TO session_rules'); db.close();
    await server.stop(); server = undefined; writeFileSync(join(root, 'node-stopped'), 'stopped');
    const start = async () => {
      daemon = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', '127.0.0.1:1'], { env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_NATIVE_SESSION_READS: undefined, O8D_BRIDGE_KEY: 'fixture-rule-read-bridge', O8D_EPOCH: 'fixture-rule-read', O8D_SESSION_DATA_DIR: root, O8D_SESSION_DB_PATH: join(root, 'cortex-ide.db'), O8D_REQUEST_COUNTS_PATH: join(root, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
      daemon.stderr!.on('data', chunk => stderr += chunk);
      origin = await new Promise<string>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('daemon startup timeout')), 10000); daemon!.stdout!.on('data', chunk => { output += chunk; for (const line of output.split('\n')) try { const row = JSON.parse(line); if (row.listening) { clearTimeout(timer); resolve('http://' + row.listening); } } catch { /* partial startup frame */ } }); daemon!.once('error', reject); });
    };
    const stop = async () => { daemon!.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); daemon = undefined; };
    const probe = async () => {
      if (!clientBinary) { console.info('[native-client-proof] Client leg skipped: O8_SESSION_RULE_CLIENT_TEST_BINARY unset; integration never builds the GUI crate. Socket restart proof remains required.'); return; }
      const name = 'ui::conversation::session_rule_product_tests::session_rules_without_node';
      const result = await run(clientBinary, [name, '--ignored', '--exact'], { env: { ...process.env, O8_SESSION_RULE_CLIENT_ORIGIN: origin, O8_SESSION_RULE_CLIENT_DATA: root, O8_NEXT_TUNNEL_HOST: undefined, O8_NEXT_WS_PORT: undefined } });
      expect(result.stdout).toContain(name + ' ... ok'); expect(result.stdout).toContain('1 passed');
    };
    await start();
    const made = await fetch(origin + route, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thoughts-review', text: 'socket restart rule', constraint: 'no_merge' }) }); expect(made.status).toBe(200); const rule = (await made.json()).result.rule;
    const listed = await fetch(origin + route + '?threadId=thoughts-review', { headers }); expect(listed.headers.get('x-o8d-native')).toBe('1'); expect((await listed.json()).result.rules).toContainEqual(rule);
    await probe(); await stop(); await start();
    const persisted = await fetch(origin + route + '?threadId=thoughts-review', { headers }); expect((await persisted.json()).result.rules).toContainEqual(rule);
    await probe(); const removed = await fetch(origin + route + '?id=' + rule.id, { method: 'DELETE', headers }); expect((await removed.json()).result.removed).toBe(true);
    const path = join(root, 'ws-token'), stamp = new Date('2026-01-01T00:00:00Z'), rotated = token.slice(0, -1) + 'X'; utimesSync(path, stamp, stamp); writeFileSync(path, rotated); utimesSync(path, stamp, stamp);
    await expect(fetch(origin + route + '?threadId=thoughts-review', { headers })).rejects.toThrow();
    expect((await fetch(origin + route + '?threadId=thoughts-review', { headers: { authorization: 'Bearer ' + rotated } })).headers.get('x-o8d-native')).toBe('1');
    for (const bearer of [worker, ...Object.values(credentials)]) await expect(fetch(origin + route + '?threadId=thoughts-review', { headers: { authorization: 'Bearer ' + bearer } })).rejects.toThrow();
    await stop(); const logs = stderr + readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8'); for (const secret of [token, rotated, worker, ...Object.values(credentials)]) expect(logs).not.toContain(secret);
  } finally { if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); } await server?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 300_000);
