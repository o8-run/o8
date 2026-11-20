import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { seedSessionFixture } from '../scripts/o8d/parity';

// This proof deliberately never starts an executor or launches a worker.
// The caller supplies the normal focused o8d build, not a candidate build.
const suppliedBinary = process.env.O8D_TEST_BINARY ?? process.env.O8D_HTTP_TEST_BINARY;
const targetDir = process.env.CARGO_TARGET_DIR ?? join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = suppliedBinary ?? join(targetDir, 'debug/o8d');
beforeAll(async () => {
  if (!suppliedBinary) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir, '--bin', 'o8d']);
}, 900_000);
it('durably deduplicates concurrent Send while the executor is absent', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-composer-admission-')));
  let daemon: ReturnType<typeof spawn> | undefined;
  let diagnostics = '';
  try {
    await seedSessionFixture(root);
    const token = readFileSync(join(root, 'ws-token'), 'utf8').trim();
    const beforeDb = new Database(join(root, 'cortex-ide.db'), { readonly: true });
    const before = beforeDb.prepare('SELECT id,status,admitted_at FROM composer_send_queue ORDER BY sequence').all(); beforeDb.close();
    const repoPath = join(root, 'fixture-repo');
    writeFileSync(join(root, 'chat-history', 'thoughts-native-admission.json'), JSON.stringify({ repoPath, messages: [] }));
    daemon = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--producer-socket', join(root, 'producer.sock')], {
      env: { ...process.env, O8_API_FRONT_DOOR: '1', O8D_NATIVE_OWNED: '1', O8D_NATIVE_SESSION_READS: undefined,
        O8D_BRIDGE_KEY: 'fixture-admission-bridge', O8D_EPOCH: 'fixture-admission',
        CORTEX_IDE_MEDIA_ROOT: undefined, O8D_REQUEST_COUNTS_PATH: join(root, 'o8d-request-counts.jsonl'),
        O8D_SESSION_DATA_DIR: root, O8D_SESSION_DB_PATH: join(root, 'cortex-ide.db') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    daemon.stderr!.on('data', chunk => { diagnostics += chunk; });
    const origin = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('o8d fixture startup timeout')), 10_000);
      daemon!.stdout!.on('data', chunk => {
        text += chunk;
        for (const line of text.split('\n')) {
          try { const row = JSON.parse(line); if (row.listening) { clearTimeout(timer); resolve('http://' + row.listening); } }
          catch { /* partial startup frame */ }
        }
      });
      daemon!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const body = { id: 'native-admission-identity', repoPath, threadId: 'thoughts-native-admission', intent: 'send-next',
      payload: { text: 'isolated fixture', wireMessage: 'isolated fixture', images: [], routing: {
        backend: 'codex', model: 'fixture-model', effort: 'low', permissionMode: 'full', mode: 'single', pickedMode: 'fast', collide: false,
      } } };
    const send = (value: unknown) => fetch(origin + '/api/orchestrator/composer-queue', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(value),
    }).catch(() => null);
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(body)));
    for (const response of responses) {
      expect(response?.headers.get('x-o8d-native'), 'Native route was not reached: durable composer admission').toBe('1');
      expect(response!.status).toBe(200);
      expect((await response!.json()).item).toMatchObject({ id: body.id, status: 'queued', admittedAt: null, payload: body.payload });
    }
    const conflict = await send({ ...body, payload: { ...body.payload, text: 'different message' } });
    expect(conflict?.status).toBe(400);
    expect(await conflict!.json()).toEqual({ error: 'This queue identity already belongs to another message.' });
    const db = new Database(join(root, 'cortex-ide.db'), { readonly: true });
    try { expect(db.prepare('SELECT id,status,admitted_at FROM composer_send_queue ORDER BY sequence').all()).toEqual([...before, { id: body.id, status: 'queued', admitted_at: null }]); }
    finally { db.close(); }
    // The non-producer facade shares the same owner and cannot claim work.
    const internal = (value: unknown, auth = token) => fetch(origin + '/internal/composer-queue', {
      method: 'POST', headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await internal({ v: 1, method: 'listTargets', params: {} }, '')).status).toBe(401);
    for (const method of ['claim', 'admit', 'settle', 'deferSteer', 'assertClaim', 'hold']) {
      expect(await (await internal({ v: 1, method, params: {} })).json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
    const normalized = JSON.stringify(body.payload);
    const retry = await (await internal({ v: 1, method: 'enqueue', params: { id: body.id, target: { repoPath, threadId: body.threadId }, intent: body.intent, payloadJson: normalized } })).json();
    expect(retry).toMatchObject({ ok: true, result: { disposition: 'existing', item: { id: body.id, status: 'queued', payload: body.payload } } });
    const list = await fetch(origin + '/api/orchestrator/composer-queue?' + new URLSearchParams({ repoPath, threadId: body.threadId }), { headers: { authorization: 'Bearer ' + token } });
    expect(list.headers.get('x-o8d-native')).toBe('1');
    expect(await list.json()).toMatchObject({ items: [{ id: body.id, payload: body.payload }], canSteer: false, steerableIds: [] });
    for (const bytes of [16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
      const response = await fetch(origin + '/api/orchestrator/composer-queue', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: ' '.repeat(bytes) });
      expect(response.status, `${bytes} Rust public request bytes`).toBe(bytes > 16 * 1024 * 1024 ? 413 : 400);
      if (response.status === 413) expect(await response.json()).toEqual({ error: 'Request exceeds 16 MiB' });
    }
    expect(diagnostics).not.toContain(token);
    expect(readFileSync(join(root, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(token);
  } finally {
    if (daemon?.exitCode === null) { daemon.kill('SIGTERM'); await new Promise<void>(resolve => daemon!.once('exit', () => resolve())); }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
