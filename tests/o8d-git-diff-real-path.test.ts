import Database from 'better-sqlite3';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';
import { DEVICE_SECRET, ENV_SECRET, gitDiffCorpus, ROTATED_SECRET, tokenHash, WORKER_SECRET } from '../scripts/o8d/git-diff-parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir]);
}, 900_000);

it.skipIf(process.platform !== 'linux')('serves owned git diffs with Next absent: repo states, auth, path safety, source redaction and rotation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-git-diff-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  const previous = process.env.O8_GIT_DIFF_SECRET;
  process.env.O8_GIT_DIFF_SECRET = ENV_SECRET;
  try {
    await seedSessionFixture(directory);
    const operator = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const corpus = gitDiffCorpus(directory, operator);
    // Name the inventory routes here and drive each route's real auth matrix;
    // provenance must not depend on the helper's corpus ordering.
    const authCases = ['/api/worktrees/diff', '/api/worktrees/diff-summary', '/api/panel/file-diff'].map(route => {
      const test = corpus.find(test => test.label.startsWith('clean:') && test.path.split('?')[0] === route);
      expect(test, `Missing clean auth fixture for ${route}`).toBeDefined();
      return test!;
    });
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const capturedStderr = join(directory, 'o8d-stderr');
    const captureBinary = join(directory, 'o8d-capture');
    writeFileSync(captureBinary, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(capturedStderr) + '\n', { mode: 0o700 });
    const recorded: unknown[] = [];
    const auth = new Map<string, unknown>();
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false });
    await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    for (const test of corpus) { const { status, body } = await send(server, test.path); recorded.push({ status, body }); }
    for (const test of authCases) for (const bearer of ['', 'wrong', WORKER_SECRET, DEVICE_SECRET, 'o8ro_fixture', 'o8pw_unknownfixture']) {
      const { status, body } = await send(server, test.path, { authorization: bearer ? `Bearer ${bearer}` : '' });
      auth.set(test.path + bearer, { status, body });
    }
    await server.stop(); server = undefined;
    server = await startSessionServer(directory, false, captureBinary);
    for (const [index, test] of corpus.entries()) {
      const { status, body, native } = await send(server, test.path);
      expect(native, 'Native route was not reached: ' + test.label + ' ' + test.path).toBe(test.native);
      expect(firstDifference(recorded[index], { status, body }), test.label).toBeNull();
      if (test.label === 'capped:panel') expect(body).toMatchObject({ diff: '[redacted]\n', diffStatus: 'truncated' });
      if (test.label === 'redaction:diff' || test.label === 'redaction:panel') {
        const wire = JSON.stringify(body);
        for (const [index, secret] of [ENV_SECRET, operator, DEVICE_SECRET].entries()) expect(wire.includes(secret), test.label + ': material ' + index).toBe(false);
        expect(wire).toContain('[redacted]');
      }
    }
    for (const test of authCases) for (const bearer of ['', 'wrong', WORKER_SECRET, DEVICE_SECRET, 'o8ro_fixture', 'o8pw_unknownfixture']) {
      const { status, body, native } = await send(server, test.path, { authorization: bearer ? `Bearer ${bearer}` : '',
        'x-o8d-redaction': 'viewer/1', 'x-o8d-bridge': 'spoofed', 'x-o8d-session-read': 'authorize' });
      expect(firstDifference(auth.get(test.path + bearer), { status, body })).toBeNull();
      if (status >= 400) expect(native).toBe(false);
    }
    // Rotate the canonical persisted device projection without restarting o8d or Node.
    const db = new Database(join(directory, 'cortex-ide.db'));
    try { db.prepare('UPDATE mobile_devices SET token_hash = ? WHERE id = ?').run(tokenHash(ROTATED_SECRET), 'diff-device'); } finally { db.close(); }
    writeFileSync(join(directory, 'mobile-device-tokens'), tokenHash(ROTATED_SECRET) + '\n');
    const rotated = await send(server, corpus[0].path, { authorization: `Bearer ${ROTATED_SECRET}` });
    expect([rotated.status, rotated.native]).toEqual([200, true]);
    const revoked = await send(server, corpus[0].path, { authorization: `Bearer ${DEVICE_SECRET}` });
    expect(revoked.status).toBe(401); expect(revoked.native).toBe(false);
    const afterRotation = await send(server, corpus.find(test => test.label === 'redaction:diff')!.path);
    expect(JSON.stringify(afterRotation.body)).toContain(DEVICE_SECRET);
    const logs = readFileSync(capturedStderr, 'utf8') + server.diagnostics().stderr + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    for (const secret of [ENV_SECRET, operator, DEVICE_SECRET, ROTATED_SECRET]) expect(logs.includes(secret)).toBe(false);
    console.log(`git-diff parity: ${corpus.length} responses, ${auth.size} auth outcomes, zero differences; rotation passed`);
    await server.stop(); server = undefined;
    process.env.O8_GIT_DIFF_SECRET = 'z'.repeat(16 * 1024 + 1);
    server = await startSessionServer(directory, false, captureBinary);
    const oversized = await send(server, corpus[0].path);
    expect([oversized.status, oversized.native]).toEqual([200, false]);
    expect(firstDifference(recorded[0], { status: oversized.status, body: oversized.body })).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.O8_GIT_DIFF_SECRET; else process.env.O8_GIT_DIFF_SECRET = previous;
    await server?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.platform !== 'linux')('refuses missing, malformed, oversized and unsupported per-request grants through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-git-grant-')));
  let mode = 'valid'; let stderr = ''; let stdout = '';
  const policy = { normalizedValues: [ENV_SECRET], activeCredentialHashes: [] as string[] };
  const grant = () => ({ version: mode === 'version' ? 2 : 1,
    defaultsContext: { projectsHome: directory, gitDiffDefaultRoot: directory },
    redaction: mode === 'stale' ? { ...policy, knownValues: [] }
      : mode === 'array' ? { ...policy, normalizedValues: [false] } : mode === 'count' ? { ...policy, normalizedValues: Array(1025).fill('x') }
        : mode === 'string' ? { ...policy, activeCredentialHashes: ['x'.repeat(16 * 1024 + 1)] } : policy });
  const upstream = createServer((req, res) => {
    if (req.headers['x-o8d-session-read'] === 'authorize') {
      expect(req.headers['x-o8d-redaction']).toBe('viewer/1');
      if (mode === 'missing') res.writeHead(204).end();
      else res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(mode === 'malformed' ? '{' : mode === 'body' ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify(grant()));
    } else res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end('{"fallback":true}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as { port: number };
  const child = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', `127.0.0.1:${address.port}`], {
    env: { ...process.env, O8D_BRIDGE_KEY: 'grant-fixture', O8D_EPOCH: 'grant-fixture', O8D_NATIVE_SESSION_READS: '0', O8D_NATIVE_OWNED: '1',
      O8D_SESSION_DATA_DIR: directory, O8D_REQUEST_COUNTS_PATH: join(directory, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o8d startup timeout')), 10_000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        for (const line of stdout.split('\n')) try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve('http://' + value.listening); } } catch { /* partial line */ }
      });
      child.once('error', reject);
    });
    const request = () => fetch(origin + '/api/worktrees/diff?sessionKey=missing');
    const valid = await request(); expect(valid.headers.get('x-o8d-native')).toBe('1'); await valid.json();
    for (mode of ['missing', 'malformed', 'version', 'stale', 'array', 'count', 'string', 'body']) {
      const response = await request(); expect(response.headers.get('x-o8d-native'), mode).toBeNull();
      expect(await response.json()).toEqual({ fallback: true });
    }
    mode = 'valid';
    const recovered = await request(); expect(recovered.headers.get('x-o8d-native')).toBe('1'); await recovered.json();
    const counts = readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    expect((stderr + stdout + counts).includes(ENV_SECRET)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
