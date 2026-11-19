import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
import { startParityReference } from './fixtures/ws-parity-server';
const list = '/api/prompt-library', entry = '/api/prompt-library/[id]', use = '/api/prompt-library/[id]/use';
const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/session-reads/debug/o8d');
const clientBinary = process.env.O8_PROMPT_CLIENT_TEST_BINARY;
const run = promisify(execFile);
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await run('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', 'crates/o8d/target/session-reads']);

}, 1_800_000);
function environment(directory: string) {
  return { ...process.env, O8_API_FRONT_DOOR: undefined, O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') };
}
async function fixture(directory: string, script: string) {
  await run(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/' + script], { env: environment(directory) });
}
async function value(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() };
}
function nodeWriter(origin: string, path: string, token: string, method: string, body = {}) {
  return new Promise<{ status: number; body: unknown; native: string | undefined }>((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), native: res.headers['x-o8d-native'] as string | undefined }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}
// Withhold the body to prove the gate/limit answer from headers; don't race
// an early HTTP refusal against pumping a 17 MiB upload into a closing socket.
function oversizedHead(origin: string, token: string) {
  return new Promise<{ status: number; native: string | undefined; body: unknown }>((resolve, reject) => {
    const req = httpRequest(origin + list, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-length': String(16 * 1024 * 1024 + 1) } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.once('error', reject);
      res.on('end', () => { resolve({ status: res.statusCode!, native: res.headers['x-o8d-native'] as string | undefined, body: JSON.parse(body) }); req.destroy(); });
    });
    req.once('error', reject); req.setTimeout(10000, () => req.destroy(Error('Prompt gate waited for a body'))); req.flushHeaders();
  });
}
it.skipIf(process.platform !== 'linux')('owns every product prompt write, matches classic handlers and persists the real window workflow with Node stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-prompt-writes-')));
  const oracle = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-prompt-oracle-')));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let daemon: ReturnType<typeof spawn> | undefined;
  let stderr = '';
  try {
    writeFileSync(join(oracle, 'prompt-oracle-owner'), 'classic-only');
    for (const root of [directory, oracle]) { await seedSessionFixture(root); await fixture(root, 'o8d-prompt-write-seed.ts'); }
    const original = new Database(join(directory, 'cortex-ide.db'), { readonly: true });
    const preexisting = original.prepare('SELECT * FROM prompt_library ORDER BY id').all(); original.close();
    server = await startParityReference({ directory, nativeHttp: true, productFrontDoor: true, o8d: true, nativeSessionReads: 'default', binary, startupTimeoutMs: 180_000 }); await server.stopNext();
    let origin = server.url.replace('ws:', 'http:').replace('/ws', ''); const token = server.token;
    const send = (path: string, method: string, body?: unknown, bearer = token, headers = {}) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parity = async (path: string, method: string, body?: unknown) => {
      const started = Date.now();
      const response = await send(path, method, body);
      expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + method + ' ' + path).toBe('1');
      const actual = await value(response), prompt = actual.body.prompt;
      const finished = Date.now();
      if (actual.body.created === true) {
        expect(prompt.id).toMatch(/^prompt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(prompt.createdAt).toBeGreaterThanOrEqual(started); expect(prompt.createdAt).toBeLessThanOrEqual(finished); expect(prompt.updatedAt).toBe(prompt.createdAt);
      }
      if (prompt && method === 'PATCH') { expect(prompt.updatedAt).toBeGreaterThanOrEqual(started); expect(prompt.updatedAt).toBeLessThanOrEqual(finished + 1); }
      if (prompt && path.endsWith('/use')) { expect(prompt.lastUsedAt).toBeGreaterThanOrEqual(started); expect(prompt.lastUsedAt).toBeLessThanOrEqual(finished); }

      // Only the isolated TS oracle's nondeterministic generators are controlled.
      // Neither production implementation has a test clock/ID override.
      writeFileSync(join(oracle, 'prompt-oracle-input.json'), JSON.stringify({ path, method, body, now: prompt?.lastUsedAt ?? prompt?.updatedAt, uuid: actual.body.created ? prompt.id.slice('prompt-'.length) : undefined }));
      await fixture(oracle, 'o8d-prompt-write-oracle.ts');
      expect(actual).toEqual(JSON.parse(readFileSync(join(oracle, 'prompt-oracle-output.json'), 'utf8')));
      return actual;
    };
    const created = await parity(list, 'POST', { title: '  fixture created  ', body: '\r\nhello  \r\nworld\r', tags: [' A  B ', 'a b', '雪'], scope: 'repo', repoPath: ' /fixture/repo ' });
    const id = created.body.prompt.id, path = entry.replace('[id]', id);
    await parity(list, 'POST', { title: 'dedupe', body: 'hello\nworld', scope: 'repo', repoPath: '/fixture/repo' });
    const edited = await parity(path, 'PATCH', { title: 'edited', expectedUpdatedAt: created.body.prompt.updatedAt });
    await parity(path, 'PATCH', { title: 'stale', expectedUpdatedAt: created.body.prompt.updatedAt });
    await parity(path, 'PATCH', { body: 'preexisting fixture row', scope: 'global' });
    await parity(use.replace('[id]', id), 'POST', {});
    await parity(path + '?expectedUpdatedAt=1', 'DELETE');
    await parity(path + '?expectedUpdatedAt=' + edited.body.prompt.updatedAt, 'DELETE');
    await parity(path, 'PATCH', { title: '' });
    await parity(use.replace('[id]', 'missing'), 'POST', {});
    for (const body of [null, {}, { title: 1 }, { title: '', body: 'x' }, { title: 'x', body: '' }, { title: 'x', body: 'x', tags: [1] }, { title: 'x', body: 'x', scope: 'bad' }, { title: 'x', body: 'x', scope: 'repo' }, { title: 'x', body: 'x', repoPath: 1 }, { title: '𝒳'.repeat(61), body: 'x' }, { title: 'x', body: 'x', tags: Array(13).fill('tag') }]) await parity(list, 'POST', body);
    for (const body of [{ expectedUpdatedAt: 0 }, { title: 1 }, { body: null }, { tags: null }]) await parity(entry.replace('[id]', 'existing'), 'PATCH', body);
    for (const revision of ['0', 'bad', '1.5', '0x14', '1e2']) await parity(entry.replace('[id]', 'absent') + '?expectedUpdatedAt=' + revision, 'DELETE');
    for (const [writer, method] of [[list, 'POST'], [entry.replace('[id]', 'existing'), 'PATCH'], [entry.replace('[id]', 'existing'), 'DELETE'], [use.replace('[id]', 'existing'), 'POST'], [list + '/import', 'POST']]) {
      const refused = await nodeWriter(origin, writer, token, method, { title: 'no second writer', body: 'refused', sources: [] });
      expect(refused.native).toBeUndefined(); expect(refused.status).toBe(503); expect(refused.body).toMatchObject({ error: { code: 'prompt_library_native_owner' } });
    }
    await fixture(directory, 'o8d-prompt-auth-seed.ts');
    const credentials = Object.values(JSON.parse(readFileSync(join(directory, 'prompt-credentials.json'), 'utf8'))) as string[];
    for (const bearer of credentials) {
      const expected = await nodeWriter(origin, list, bearer, 'POST', { title: 'refused', body: 'refused' });
      const response = await send(list, 'POST', { title: 'refused', body: 'refused' }, bearer);
      expect(response.headers.get('x-o8d-native')).toBeNull(); expect(expected.status).toBe(403);
      expect({ status: response.status, body: await response.json() }).toEqual({ status: expected.status, body: expected.body });
    }
    for (const bearer of ['', 'wrong']) expect((await send(list, 'POST', { title: 'refused', body: 'refused' }, bearer)).status).toBe(401);
    expect((await send(list, 'POST', {}, token, { origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await send(list, 'POST', {}, token, { 'user-agent': 'Mozilla/5.0' })).status).toBe(403);
    // A bad schema refuses before any mutation. Node's product store is fenced too.
    const db = new Database(join(directory, 'cortex-ide.db')); db.exec('DROP INDEX idx_prompt_library_global_body');
    expect((await send(list, 'POST', { title: 'schema refusal', body: 'must not persist' })).status).toBe(503);
    expect(db.prepare("SELECT count(*) n FROM prompt_library WHERE body='must not persist'").get()).toEqual({ n: 0 });
    db.exec("CREATE UNIQUE INDEX idx_prompt_library_global_body ON prompt_library(body_fingerprint) WHERE scope = 'global'"); db.close();
    const tooLarge = await oversizedHead(origin, token);
    expect(tooLarge.status).toBe(413); expect(tooLarge.native).toBe('1');
    expect(tooLarge.body).toEqual({ error: 'Request exceeds 16 MiB' });
    const deniedHead = await oversizedHead(origin, 'wrong');
    expect(deniedHead.status).toBe(401); expect(deniedHead.native).toBeUndefined();
    const port = new URL(origin).port; await server.stop(); server = undefined; writeFileSync(join(directory, 'node-stopped'), 'stopped');
    const stop = async () => { if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); } daemon = undefined; };
    const start = async () => {
      daemon = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', '127.0.0.1:' + port], { env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_NATIVE_SESSION_READS: undefined, O8D_BRIDGE_KEY: 'fixture-prompt-write-bridge', O8D_EPOCH: 'fixture-prompt-writes', O8D_SESSION_DATA_DIR: directory, O8D_SESSION_DB_PATH: join(directory, 'cortex-ide.db'), O8D_REQUEST_COUNTS_PATH: join(directory, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
      daemon.stderr!.on('data', chunk => stderr += chunk);
      origin = await new Promise<string>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('daemon timeout')), 10000); daemon!.stdout!.on('data', chunk => { output += chunk; for (const line of output.split('\n')) try { const data = JSON.parse(line); if (data.listening) { clearTimeout(timer); resolve('http://' + data.listening); } } catch { /* incomplete startup JSON */ } }); daemon!.once('error', reject); });
    };
    const client = async () => {
      if (!clientBinary) { console.info('[native-client-proof] Client leg not run: O8_PROMPT_CLIENT_TEST_BINARY is unset; socket CRUD/restart/auth proof remains required.'); return; }
      const name = 'shell::customize::prompt_writer_tests::saved_prompt_writes_without_node';
      const result = await run(clientBinary!, [name, '--ignored', '--exact'], { env: { ...process.env, O8_PROMPT_CLIENT_ORIGIN: origin, O8_PROMPT_CLIENT_DATA: directory, O8_NEXT_TUNNEL_HOST: undefined, O8_NEXT_WS_PORT: undefined } });
      expect(result.stdout).toContain(name + ' ... ok'); expect(result.stdout).toContain('1 passed');
      console.info('[native-client-proof] Supplied window Client phase: 1 passed with Node stopped.');
    };
    await start();
    const socketCreate = await send(list, 'POST', { title: 'socket workflow', body: 'socket persistence fixture' });
    expect(socketCreate.status).toBe(201); expect(socketCreate.headers.get('x-o8d-native')).toBe('1');
    const socketPrompt = (await socketCreate.json()).prompt, socketPath = entry.replace('[id]', socketPrompt.id);
    const socketEdit = await send(socketPath, 'PATCH', { title: 'socket edited', expectedUpdatedAt: socketPrompt.updatedAt });
    expect(socketEdit.status).toBe(200); expect(socketEdit.headers.get('x-o8d-native')).toBe('1'); await socketEdit.arrayBuffer();
    const socketUse = await send(use.replace('[id]', socketPrompt.id), 'POST', {});
    expect(socketUse.status).toBe(200); expect(socketUse.headers.get('x-o8d-native')).toBe('1');
    const used = (await socketUse.json()).prompt;
    expect(used.title).toBe('socket edited'); expect(used.useCount).toBe(1); expect(used.lastUsedAt).toBeGreaterThan(0);
    await client(); await stop(); await start();
    const reopened = await send(socketPath, 'GET'); expect(reopened.status).toBe(200); expect(reopened.headers.get('x-o8d-native')).toBe('1'); expect((await reopened.json()).prompt).toEqual(used);
    const ordered = await send(list + '?scope=all', 'GET'); expect(ordered.headers.get('x-o8d-native')).toBe('1');
    const ids = (await ordered.json()).prompts.map((prompt: { id: string }) => prompt.id);
    expect(ids.indexOf(socketPrompt.id)).toBeGreaterThanOrEqual(0); expect(ids.indexOf(socketPrompt.id)).toBeLessThan(ids.indexOf('existing'));
    const socketDelete = await send(socketPath + '?expectedUpdatedAt=' + used.updatedAt, 'DELETE'); expect(socketDelete.status).toBe(200); expect(socketDelete.headers.get('x-o8d-native')).toBe('1'); await socketDelete.arrayBuffer();
    await client();
    // No cached operator authority on writes, even when size and mtime match.
    const tokenPath = join(directory, 'ws-token'), date = new Date('2026-01-01T00:00:00.000Z'), rotated = token.slice(0, -1) + 'X';
    utimesSync(tokenPath, date, date); const before = statSync(tokenPath);
    const warmed = await send(list, 'POST', { title: 'warm authority', body: 'preexisting fixture row' }); expect(warmed.status).toBe(200); await warmed.arrayBuffer();
    writeFileSync(tokenPath, rotated); utimesSync(tokenPath, date, date);
    const after = statSync(tokenPath); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(send(list, 'POST', { title: 'refused', body: 'stale credential' })).rejects.toThrow();
    const rotation = await send(list, 'POST', { title: 'rotation', body: 'fresh credential write' }, rotated);
    expect(rotation.status).toBe(201); expect(rotation.headers.get('x-o8d-native')).toBe('1');
    const rotatedId = (await rotation.json()).prompt.id;
    expect((await send(entry.replace('[id]', rotatedId), 'DELETE', undefined, rotated)).status).toBe(200);
    writeFileSync(tokenPath, token);
    const persisted = new Database(join(directory, 'cortex-ide.db'), { readonly: true });
    expect(persisted.prepare('SELECT * FROM prompt_library ORDER BY id').all()).toEqual(preexisting);
    expect(persisted.prepare('SELECT * FROM prompt_library WHERE id=?').get(socketPrompt.id)).toBeUndefined(); persisted.close();
    expect(stderr + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(token);
    expect(stderr + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(rotated);
    for (const credential of credentials) expect(stderr + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(credential);
    await stop();
  } finally {
    if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); }
    await server?.stop(); for (const root of [directory, oracle]) rmSync(root, { recursive: true, force: true });
  }
}, 600_000);
