import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug', 'o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir]);
}, 900_000);

it.skipIf(process.platform !== 'linux')('serves file content through the public socket with Next absent and exact viewer spans', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-file-content-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  const previousCap = process.env.O8_FILE_EDIT_MAX_BYTES;
  process.env.O8_FILE_EDIT_MAX_BYTES = '4096';
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'plain.txt'), 'plain content\n');
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    writeFileSync(join(directory, 'sensitive.txt'), token + '\n');
    writeFileSync(join(directory, 'large.txt'), 'x'.repeat(110_000));
    writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join(directory, 'patch.txt'), 'prefix\r@@ -1 +1 @@\r-before\r+after\r');
    const treeRoot = join(directory, 'tree'); mkdirSync(treeRoot);
    const git = (...args: string[]) => execFileSync('git', ['-C', treeRoot, ...args], { stdio: 'pipe' });
    git('init', '-q'); writeFileSync(join(treeRoot, 'tracked.txt'), 'tracked'); git('add', '.');
    writeFileSync(join(treeRoot, 'untracked.txt'), 'untracked');
    for (const name of ['alpha_one.txt', 'alpha-one.txt', 'alpha.one.txt', 'alphaone.txt']) writeFileSync(join(treeRoot, name), 'punctuation order');
    for (const name of ['node_modules', 'dist', 'target', '.git']) {
      if (name !== '.git') mkdirSync(join(treeRoot, name));
      writeFileSync(join(treeRoot, name, 'ignored.txt'), 'ignored');
    }
    const registeredRoot = join(directory, 'registered'); mkdirSync(registeredRoot);
    writeFileSync(join(registeredRoot, 'plain.txt'), 'registered content');
    writeFileSync(join(registeredRoot, 'sensitive.txt'), token);
    // A BMP and an astral letter precede each marker: the wire contract uses UTF-8 bytes.
    const unicodeName = '雪 𐐀 ' + token + '.txt';
    writeFileSync(join(registeredRoot, unicodeName), 'plain content');
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'fixture-registered', name: 'Fixture', localPath: registeredRoot, isGitRepo: false, defaultBranch: 'main', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' }] }));
    const cases = ['/api/panel/file-content', '/api/v2/files'].flatMap(route => [
      ...['plain.txt', 'sensitive.txt', 'large.txt', 'binary.bin', 'patch.txt'].map(path => route + '?' + new URLSearchParams({ path })),
      route, route + '?path=../outside',
    ]);
    cases.push('/api/v2/files?path=large.txt&preview=1');
    for (const route of ['/api/panel/file-content', '/api/v2/files']) {
      for (const path of ['plain.txt', 'sensitive.txt', unicodeName, '../outside']) cases.push(route + '?' + new URLSearchParams({ workspace: registeredRoot, path }));
    }
    const treeQueries: Record<string, string>[] = [{}, { search: 'tracked' }, { recursive: 'files' }];
    for (const query of treeQueries) {
      const route = '/api/panel/files';
      cases.push(route + '?' + new URLSearchParams({ workspace: treeRoot, ...query }));
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const captureBinary = join(directory, 'capture-o8d');
    const stderrPath = join(directory, 'o8d-stderr');
    writeFileSync(captureBinary, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    const recorded: unknown[] = [];
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false });
    await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    for (const path of cases) { const { status, body } = await send(server, path); recorded.push({ status, body });
      if (new URL(path, 'http://fixture').searchParams.get('path') === unicodeName) expect(body).toMatchObject({ redaction: { spans: expect.arrayContaining([expect.objectContaining({ start: 9, end: 19, path: '/path' })]) } });
    }
    const treePath = '/api/panel/files?' + new URLSearchParams({ workspace: treeRoot });
    // Vary only an ignored probe parameter: the handler's cache key stays root.
    const checkCache = async () => {
      const before = await send(server!, treePath + '&cacheProbe=before');
      expect(before.body).toMatchObject({ root: treeRoot });
      const beforeDate = Date.parse((await fetch(server!.origin + '/health')).headers.get('date')!);
      writeFileSync(join(treeRoot, 'late.txt'), 'late');
      expect(firstDifference(before.body, (await send(server!, treePath + '&cacheProbe=during')).body)).toBeNull();
      // Leave margin beyond the 15-second window and HTTP Date granularity.
      await new Promise(resolve => setTimeout(resolve, 17_000));
      expect(readFileSync(join(treeRoot, 'late.txt'), 'utf8')).toBe('late');
      const afterDate = Date.parse((await fetch(server!.origin + '/health')).headers.get('date')!);
      expect(afterDate - beforeDate).toBeGreaterThanOrEqual(15_000);
      const refreshed = await send(server!, treePath + '&cacheProbe=after');
      expect(refreshed.body).toMatchObject({ tree: expect.arrayContaining([expect.objectContaining({ path: 'late.txt' })]) });
      return refreshed.body;
    };
    const expectedRefresh = await checkCache();
    unlinkSync(join(treeRoot, 'late.txt'));
    await server.stop(); server = undefined;
    server = await startSessionServer(directory, false, captureBinary);
    for (const [index, path] of cases.entries()) {
      const { status, body, native } = await send(server, path);
      expect(native, 'Native route was not reached: ' + path).toBe(!(path.startsWith('/api/v2/files') && decodeURIComponent(path).includes('../outside')));
      expect(firstDifference(recorded[index], { status, body })).toBeNull();
      if (path.includes('patch.txt')) expect(body).toMatchObject({ content: '[redacted]' });
      if (path.includes('sensitive.txt')) expect(JSON.stringify(body)).not.toContain(token);
      if (path === '/api/v2/files?path=large.txt&preview=1') expect(body).toMatchObject({ truncated: true, size: 110_000 });
      if (path.includes('path=large.txt') && path.startsWith('/api/panel/file-content')) expect(body).toMatchObject({ truncated: true });
    }
    expect(firstDifference(expectedRefresh, await checkCache())).toBeNull();
    // The live Node resolver may still authorize its cached registry snapshot.
    // Rust must use that attestation, not re-read or replicate repos.json.
    const scopedPath = '/api/panel/file-content?' + new URLSearchParams({ workspace: registeredRoot, path: 'plain.txt' });
    expect((await send(server, scopedPath)).native).toBe(true);
    const registry = readFileSync(join(directory, 'repos.json'));
    unlinkSync(join(directory, 'repos.json'));
    try { expect((await send(server, scopedPath)).native).toBe(true); }
    finally { writeFileSync(join(directory, 'repos.json'), registry); }
    for (const route of ['/api/panel/file-content', '/api/v2/files']) {
      const unregistered = await send(server, route + '?' + new URLSearchParams({ path: 'plain.txt', workspace: join(directory, 'unregistered') }));
      expect([unregistered.status, unregistered.native]).toEqual([400, false]);
    }
    const write = await fetch(server.origin + '/api/v2/files', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'created.txt', content: 'created' }) });
    expect(write.status).toBe(200); expect(write.headers.get('x-o8d-native')).toBeNull();
    expect(await write.json()).toMatchObject({ success: true, isNew: true });
    expect(readFileSync(join(directory, 'created.txt'), 'utf8')).toBe('created');
    expect((await send(server, '/api/v2/files?path=created.txt')).native).toBe(true);
    const logs = readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    expect(logs).not.toContain(token);
  } finally {
    if (previousCap === undefined) delete process.env.O8_FILE_EDIT_MAX_BYTES; else process.env.O8_FILE_EDIT_MAX_BYTES = previousCap;
    await server?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.platform !== 'linux')('replays content reads through TypeScript when the private viewer grant is missing or malformed', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-file-grant-')));
  let reference: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let mode = 'missing'; let output = ''; let stderr = '';
  const upstream = createServer(async (req, res) => {
    if (req.headers['x-o8d-session-read'] === 'authorize') {
      expect(req.headers['x-o8d-redaction']).toBe('viewer/1');
      res.writeHead(mode === 'missing' ? 204 : 200, { 'content-type': 'application/json', connection: 'close' }).end(mode === 'missing' ? undefined : '{');
    } else {
      const origin = reference!.url.replace('ws:', 'http:').replace('/ws', '');
      const response = await fetch(origin + req.url, { headers: { authorization: `Bearer ${reference!.token}` } });
      res.writeHead(response.status, { 'content-type': 'application/json', connection: 'close' }).end(await response.text());
    }
  });
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'plain.txt'), 'plain');
    reference = await startParityReference({ directory, nativeHttp: true, o8d: false });
    await reference.stopNext();
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as { port: number };
    child = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', `127.0.0.1:${address.port}`], {
      env: { ...process.env, O8D_BRIDGE_KEY: 'file-grant-fixture', O8D_EPOCH: 'file-grant-fixture', O8D_NATIVE_SESSION_READS: '0', O8D_NATIVE_OWNED: '1',
        O8D_SESSION_DATA_DIR: directory, O8D_REQUEST_COUNTS_PATH: join(directory, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o8d startup timeout')), 10_000);
      child!.stdout!.on('data', chunk => {
        output += chunk.toString();
        for (const line of output.split('\n')) try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve('http://' + value.listening); } } catch { /* Partial output. */ }
      });
      child!.once('error', reject);
    });
    const referenceOrigin = reference.url.replace('ws:', 'http:').replace('/ws', '');
    for (mode of ['missing', 'malformed']) for (const route of ['/api/panel/file-content', '/api/v2/files', '/api/panel/files']) {
      const path = route + '?' + new URLSearchParams({ path: 'plain.txt' });
      const expected = await fetch(referenceOrigin + path, { headers: { authorization: `Bearer ${reference.token}` } });
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${reference.token}` } });
      expect(response.headers.get('x-o8d-native'), mode + ':' + route).toBeNull();
      expect(firstDifference(await expected.json(), await response.json())).toBeNull();
    }
    expect(stderr + output + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(reference.token);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await reference?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

// Paired with the Rust ViewerRedaction prefix matrix; this is the canonical renderer.
it('keeps top-level and nested viewer JSON spans in UTF-8 byte units', async () => {
  const { viewerJson } = await import('../src/lib/viewers/response');
  for (const [prefix, start] of [['雪 ', 4], ['𐐀 ', 5], ['雪 𐐀 ', 9]] as const) {
    const input = prefix + 'fixture-value tail fixture-value';
    const response = viewerJson({ content: input, files: [{ path: input }], diff: input }, undefined,
      { normalizedValues: ['fixture-value'], verifiedDiffs: new Set([input]) });
    const body = await response.json();
    expect(body.redaction).toEqual({ version: 1, offsetEncoding: 'utf-8', spans:
      ['/content', '/files/0/path', '/diff'].flatMap(path => [
        { start, end: start + 10, kind: 'credential', path },
        { start: start + 16, end: start + 26, kind: 'credential', path },
      ]),
    });
  }
});
