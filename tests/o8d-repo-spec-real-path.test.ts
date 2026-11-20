import Database from 'better-sqlite3';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug', 'o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir]);
}, 900_000);
const route = '/api/repo-spec';
const asset = '/api/repo-spec/asset';
const pathFor = (repoPath: string, view?: string) => route + '?' + new URLSearchParams({ repoPath, ...(view === undefined ? {} : { view }) });
async function snapshot(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.text() };
}

it.skipIf(process.platform !== 'linux')('reads scoped specs on the public socket with Next absent, fresh contents, and canonical viewer redaction', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-repo-spec-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    const operator = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const worker = 'o8pw_' + 'n'.repeat(43);
    const digest = createHash('sha256').update(worker).digest('hex');
    const roots = Object.fromEntries(['existing', 'missing', 'sensitive', 'masked', 'unicode', 'symlink', 'nonfile'].map(name => { const root = join(directory, name); mkdirSync(root); return [name, root]; }));
    writeFileSync(join(roots.existing, 'o8.md'), '# Spec\n\nPublic notes.\n');
    writeFileSync(join(roots.sensitive, 'o8.md'), '# Spec\n\n' + operator + '\n');
    writeFileSync(join(roots.masked, 'o8.md'), '# Spec\n\n[redacted]\n');
    writeFileSync(join(roots.unicode, 'o8.md'), '# Spec\n\nCaf\u00e9\n');
    writeFileSync(join(directory, 'private-spec'), operator);
    symlinkSync(join(directory, 'private-spec'), join(roots.symlink, 'o8.md'));
    mkdirSync(join(roots.nonfile, 'o8.md'));
    const db = new Database(join(directory, 'cortex-ide.db'));
    try {
      db.prepare(`INSERT INTO worker_tokens (id, token_hash, packet_id, label, scope, max_workers, created_at) VALUES ('spec-fixture-worker', ?, 'spec-fixture', 'Fixture', 'local-packet', 1, '2026-01-01')`).run(digest);
      db.prepare(`INSERT INTO lanes (id, label, repo_path, worktree_path, branch, base_branch, runtime, session_key, status, ownership, packet_id, created_at, updated_at) VALUES ('spec-fixture-lane', 'Fixture', ?, ?, 'fixture', 'main', 'codex', 'fixture:spec', 'running', 'attached', 'spec-fixture', '2026-01-01', '2026-01-01')`).run(roots.existing, roots.existing);
    } finally { db.close(); }
    writeFileSync(join(directory, 'worker-packet-token-hashes'), digest + '\n');
    const cases = [
      ...['existing', 'missing', 'sensitive', 'masked', 'symlink', 'nonfile'].map(name => ({ path: pathFor(roots[name]), native: true })),
      { path: pathFor(roots.unicode), native: false }, { path: pathFor(join(directory, 'invalid')), native: false }, { path: route, native: false },
      ...['index', 'validate'].flatMap(view => ['existing', 'missing', 'sensitive'].map(name => ({ path: pathFor(roots[name], view), native: false }))),
      // This path currently has POST only. A GET retains the TS transport's 405.
      ...['normal.png', '../escape.png', 'missing.png'].map(path => ({ path: asset + '?' + new URLSearchParams({ repoPath: roots.existing, path }), native: false })),
    ];
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const stderrPath = join(directory, 'daemon-stderr'); const wrapper = join(directory, 'capture-o8d');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, bearer = operator, method = 'GET', body?: object) => fetch(server!.origin + path, { method, headers: { authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const expected = [];
    for (const entry of cases) expected.push(await snapshot(await call(entry.path)));
    const workerPaths = [pathFor(roots.existing), pathFor(roots.sensitive), pathFor(join(directory, 'invalid'))];
    const workerExpected = [];
    for (const path of workerPaths) workerExpected.push(await snapshot(await call(path, worker)));
    expect(workerExpected.map(result => result.status)).toEqual([200, 403, 403]);
    await server.stop(); server = undefined; server = await startSessionServer(directory, false, wrapper);
    for (const [index, entry] of cases.entries()) {
      const response = await call(entry.path);
      expect(response.headers.get('x-o8d-native') === '1', 'Native route was not reached: ' + entry.path).toBe(entry.native);
      expect(await snapshot(response), entry.path).toEqual(expected[index]);
    }
    for (const [index, path] of workerPaths.entries()) {
      const response = await call(path, worker);
      expect(response.headers.get('x-o8d-native') === '1').toBe(index === 0);
      expect(await snapshot(response)).toEqual(workerExpected[index]);
    }
    expect((await call(pathFor(roots.existing), '')).status).toBe(401);
    const missing = await (await call(pathFor(roots.missing))).json();
    expect(missing).toMatchObject({ ok: true, exists: false, content: expect.stringContaining('# o8 Spec') });
    const masked = await (await call(pathFor(roots.sensitive))).json();
    expect(masked.content).toContain('[redacted]'); expect(JSON.stringify(masked)).not.toContain(operator);
    // No native file cache: direct changes and the original TS writer are visible immediately.
    writeFileSync(join(roots.existing, 'o8.md'), '# Spec\n\nExternal update.\n');
    expect((await (await call(pathFor(roots.existing))).json()).content).toContain('External update.');
    const write = await call(pathFor(roots.existing), operator, 'PUT', { content: '# Spec\n\nSaved by TS.\n' });
    expect(write.status).toBe(200); expect(write.headers.get('x-o8d-native')).toBeNull();
    expect((await (await call(pathFor(roots.existing))).json()).content).toContain('Saved by TS.');
    const updatedScope = new Database(join(directory, 'cortex-ide.db'));
    try { updatedScope.prepare("UPDATE lanes SET repo_path = ?, worktree_path = ? WHERE id = 'spec-fixture-lane'").run(roots.missing, roots.missing); } finally { updatedScope.close(); }
    const oldScope = await call(pathFor(roots.existing), worker);
    expect(oldScope.status).toBe(403); expect(oldScope.headers.get('x-o8d-native')).toBeNull();
    const newScope = await call(pathFor(roots.missing), worker);
    expect(newScope.status).toBe(200); expect(newScope.headers.get('x-o8d-native')).toBe('1');
    const logs = readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    for (const secret of [operator, worker]) expect(logs).not.toContain(secret);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it.skipIf(process.platform !== 'linux')('falls back through the real TS handler on missing, malformed or unsupported spec grants', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-spec-grant-')));
  let reference: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let mode = 'missing'; let output = ''; let stderr = '';
  const upstream = createServer(async (req, res) => {
    if (req.headers['x-o8d-session-read'] === 'authorize') {
      expect(req.headers['x-o8d-redaction']).toBe('viewer/1');
      res.writeHead(mode === 'missing' ? 204 : 200, { 'content-type': 'application/json', connection: 'close' }).end(mode === 'missing' ? undefined : mode === 'malformed' ? '{' : JSON.stringify({ version: 1, defaultsContext: { repoSpecTarget: { root: 'relative', relativePath: 'o8.md', path: 'o8.md' } }, redaction: { normalizedValues: [], activeCredentialHashes: [] } }));
    } else {
      const response = await fetch(reference!.url.replace('ws:', 'http:').replace('/ws', '') + req.url, { headers: { authorization: `Bearer ${reference!.token}` } });
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), connection: 'close' }).end(Buffer.from(await response.arrayBuffer()));
    }
  });
  try {
    await seedSessionFixture(directory);
    reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    writeFileSync(join(directory, 'o8.md'), '# Spec\n\n' + reference.token + '\n');
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as { port: number };
    child = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', `127.0.0.1:${address.port}`], {
      env: { ...process.env, O8D_BRIDGE_KEY: 'spec-grant-fixture', O8D_EPOCH: 'spec-grant-fixture', O8D_NATIVE_SESSION_READS: '0', O8D_NATIVE_OWNED: '1', O8D_SESSION_DATA_DIR: directory, O8D_REQUEST_COUNTS_PATH: join(directory, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o8d startup timeout')), 10_000);
      child!.stdout!.on('data', chunk => { output += chunk.toString(); for (const line of output.split('\n')) try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve('http://' + value.listening); } } catch { /* Partial output. */ } });
      child!.once('error', reject);
    });
    for (mode of ['missing', 'malformed', 'scope']) {
      const path = pathFor(directory); const init = { headers: { authorization: `Bearer ${reference.token}` } };
      const expected = await snapshot(await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '') + path, init));
      const response = await fetch(origin + path, init);
      expect(response.headers.get('x-o8d-native')).toBeNull();
      const result = await snapshot(response); expect(result).toEqual(expected); expect(result.body).not.toContain(reference.token);
    }
    expect(stderr + output + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(reference.token);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await reference?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
