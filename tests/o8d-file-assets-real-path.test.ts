import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ensureMobileDeviceSchema } from '../src/lib/db/mobile-device-schema';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
const routes = ['/api/panel/file-io', '/api/panel/file-asset', '/api/panel/serve-image', '/api/mobile/media'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
async function snapshot(response: Response) {
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()).toString('base64'),
    headers: Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy', 'x-o8-viewer-redaction'].map(key => [key, response.headers.get(key)])) };
}
const query = (route: string, path?: string, extra: Record<string, string> = {}) => route + '?' + new URLSearchParams({ ...(path === undefined ? {} : { path }), ...extra });

it.skipIf(process.platform !== 'linux')('serves assets on the public socket with Next absent, preserving bytes, authority and viewer behavior', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-file-assets-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-assets-outside-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  const previous = { CORTEX_IDE_MEDIA_ROOT: process.env.CORTEX_IDE_MEDIA_ROOT, CORTEX_IDE_WORKSPACE_ROOT: process.env.CORTEX_IDE_WORKSPACE_ROOT, O8_FILE_EDIT_MAX_BYTES: process.env.O8_FILE_EDIT_MAX_BYTES };
  process.env.CORTEX_IDE_MEDIA_ROOT = join(directory, 'media');
  process.env.CORTEX_IDE_WORKSPACE_ROOT = directory;
  process.env.O8_FILE_EDIT_MAX_BYTES = '4096';
  try {
    await seedSessionFixture(directory);
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const worker = 'asset-fixture-worker'; const device = 'c7'.repeat(32);
    const tokenHash = createHash('sha256').update(device).digest('hex');
    const db = new Database(join(directory, 'cortex-ide.db'));
    try { ensureMobileDeviceSchema(db); db.prepare('INSERT INTO mobile_devices (id, token_hash, identity_public_key) VALUES (?, ?, ?)').run('asset-device', tokenHash, 'asset-identity'); } finally { db.close(); }
    writeFileSync(join(directory, 'worker-token'), worker); writeFileSync(join(directory, 'mobile-device-tokens'), tokenHash + '\n');
    for (const root of ['media', 'inbox', 'archive/artifacts', 'registered']) mkdirSync(join(directory, root), { recursive: true });
    const bomb = Buffer.from(PNG); bomb.writeUInt32BE(65535, 16); bomb.writeUInt32BE(65535, 20);
    const highBitHeader = Buffer.from(PNG); highBitHeader[12] |= 0x80;
    const fixtures: [string, Buffer | string][] = [ ['valid.png', PNG], ['valid.jpg', JPEG], ['valid.gif', GIF], ['valid.webp', WEBP],
      ['vector.svg', '<svg><text>safe</text></svg>'], ['sensitive.svg', '<svg><text>' + token + '</text></svg>'],
      ['marked.svg', '<svg>' + (token + ' ').repeat(100) + '</svg>'], ['invalid.svg', Buffer.from([0xff])], ['bomb.png', bomb], ['ascii-header.png', highBitHeader],
      ['plain.txt', 'plain text\n'], ['sensitive.txt', token], ['document.pdf', '%PDF-1.7\n'], ['bad.exe', 'no'],
      ['corrupt.png', PNG.subarray(0, 24)], ['mismatch.jpg', PNG], ['binary.txt', Buffer.from([0, 1, 2])], ['large.txt', 'x'.repeat(5000)] ];
    for (const root of [directory, join(directory, 'media'), join(directory, 'registered')]) for (const [name, bytes] of fixtures) { writeFileSync(join(root, name), bytes); utimesSync(join(root, name), 1_700_000_000, 1_700_000_000); }
    writeFileSync(join(outside, 'escape.png'), PNG);
    symlinkSync(join(outside, 'escape.png'), join(directory, 'escape.png'));
    symlinkSync(join(outside, 'escape.png'), join(directory, 'media', 'escape.png'));
    symlinkSync(join(directory, 'media', 'valid.png'), join(directory, 'media', 'alias.png'));
    for (const root of ['inbox', 'archive/artifacts']) writeFileSync(join(directory, root, 'valid.png'), PNG);
    const registered = join(directory, 'registered');
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'asset-fixture', name: 'Asset fixture', localPath: registered, isGitRepo: false, defaultBranch: 'main', createdAt: '2026-01-01', lastOpenedAt: '2026-01-01' }] }));
    const cases: { path: string; native: boolean }[] = [];
    for (const name of ['plain.txt', 'sensitive.txt', 'missing.txt']) cases.push({ path: query(routes[0], join(directory, name)), native: true });
    // file-io follows symlinks and uses Unicode refusal text; retain TS for those cases.
    for (const path of [query(routes[0]), query(routes[0], 'relative.txt'), query(routes[0], join(directory, 'large.txt')), query(routes[0], join(directory, 'binary.txt')), query(routes[0], join(directory, 'escape.png'))]) cases.push({ path, native: false });
    for (const route of routes.slice(1)) {
      for (const name of ['valid.png', 'valid.jpg', 'valid.gif', 'valid.webp', 'vector.svg', 'sensitive.svg', 'document.pdf', 'bad.exe', 'marked.svg', 'invalid.svg', 'bomb.png', 'ascii-header.png', 'corrupt.png', 'mismatch.jpg', 'missing.png']) {
        if (route === routes[2] && ['document.pdf', 'bad.exe'].includes(name)) { cases.push({ path: query(route, join(directory, name)), native: true }); continue; }
        cases.push({ path: query(route, route === routes[1] ? name : join(directory, route === routes[3] ? 'media' : '', name)), native: !(route === routes[3] && ['bad.exe', 'missing.png'].includes(name)) });
      }
      cases.push({ path: query(route), native: route !== routes[3] });
    }
    for (const name of ['valid.png', 'sensitive.svg']) cases.push({ path: query(routes[1], name, { workspace: registered }), native: true });
    cases.push({ path: query(routes[1], 'valid.png', { workspace: outside }), native: false });
    cases.push({ path: query(routes[1], '../outside.png'), native: true });
    cases.push({ path: query(routes[1], 'escape.png'), native: true });
    cases.push({ path: query(routes[2], '/etc/asset-outside.png'), native: false });
    cases.push({ path: query(routes[2], join(directory, 'escape.png')), native: true });
    for (const path of [join(outside, 'escape.png'), join(directory, 'media', 'escape.png'), join(directory, 'media', 'alias.png')]) cases.push({ path: query(routes[3], path), native: false });
    for (const root of ['inbox', 'archive/artifacts']) cases.push({ path: query(routes[3], join(directory, root, 'valid.png')), native: true });
    utimesSync(join(directory, 'sensitive.txt'), 1_700_000_000.123456, 1_700_000_000.123456);
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false });
    await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, authenticated = true, headers: Record<string, string> = {}) => fetch(server!.origin + path, { headers: { ...(authenticated ? { authorization: `Bearer ${server!.token}` } : {}), ...headers } });
    const expected = [];
    for (const entry of cases) expected.push(await snapshot(await call(entry.path)));
    const authPaths = [query(routes[0], join(directory, 'plain.txt')), query(routes[1], 'valid.png'), query(routes[2], join(directory, 'valid.png')), query(routes[3], join(directory, 'media', 'valid.png'))];
    const unauthenticated = [];
    for (const path of authPaths) unauthenticated.push(await snapshot(await call(path, false)));
    expect(unauthenticated.map(value => value.status)).toEqual([401, 200, 401, 401]);
    const auth = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const path of authPaths) for (const bearer of [worker, device, 'wrong']) auth.set(path + bearer, await snapshot(await call(path, false, { authorization: `Bearer ${bearer}` })));
    expect(auth.get(authPaths[0] + worker)?.status).toBe(403);
    expect(auth.get(authPaths[3] + device)?.status).toBe(200);
    await server.stop(); server = undefined;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const wrapper = join(directory, 'capture-o8d'); const stderrPath = join(directory, 'daemon-stderr');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    server = await startSessionServer(directory, false, wrapper);
    for (const [index, entry] of cases.entries()) {
      const response = await call(entry.path, true, { range: 'bytes=0-1' });
      expect(response.headers.get('x-o8d-native') === '1', 'Native route was not reached: ' + entry.path).toBe(entry.native);
      expect(await snapshot(response), entry.path).toEqual(expected[index]);
    }
    for (const [index, path] of authPaths.entries()) expect(await snapshot(await call(path, false))).toEqual(unauthenticated[index]);
    for (const path of authPaths) for (const bearer of [worker, device, 'wrong']) {
      const response = await call(path, false, { authorization: `Bearer ${bearer}`, 'x-o8d-bridge': 'spoofed', 'x-o8d-session-read': 'authorize' });
      const result = await snapshot(response); expect(result).toEqual(auth.get(path + bearer));
      if (result.status >= 400) expect(response.headers.get('x-o8d-native')).toBeNull();
    }
    const svg = await call(query(routes[1], 'sensitive.svg'));
    expect(await svg.text()).toContain('[redacted]');
    expect(svg.headers.get('x-o8-viewer-redaction')).toContain('credential');
    const write = await fetch(server.origin + routes[0], { method: 'PUT', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: join(directory, 'plain.txt'), content: 'updated', expectedMtimeMs: 1_700_000_000_000 }) });
    expect(write.status).toBe(200); expect(write.headers.get('x-o8d-native')).toBeNull();
    expect(readFileSync(join(directory, 'plain.txt'), 'utf8')).toBe('updated');
    const logs = readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    for (const secret of [token, worker, device]) expect(logs).not.toContain(secret);
    console.log(`file-assets parity: ${cases.length} byte-identical responses, ${auth.size + unauthenticated.length} additional auth outcomes; grants and logs checked`);
  } finally {
    await server?.stop();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.platform !== 'linux')('defers all asset routes to real TypeScript on missing or malformed viewer admission', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-asset-grant-')));
  let reference: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let mode = 'missing'; let output = ''; let stderr = '';
  const upstream = createServer(async (req, res) => {
    if (req.headers['x-o8d-session-read'] === 'authorize') {
      expect(req.headers['x-o8d-redaction']).toBe('viewer/1');
      res.writeHead(mode === 'missing' ? 204 : 200, { 'content-type': 'application/json', connection: 'close' }).end(mode === 'missing' ? undefined : '{');
    } else {
      const response = await fetch(reference!.url.replace('ws:', 'http:').replace('/ws', '') + req.url, { headers: { authorization: `Bearer ${reference!.token}` } });
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), connection: 'close' }).end(Buffer.from(await response.arrayBuffer()));
    }
  });
  try {
    await seedSessionFixture(directory); writeFileSync(join(directory, 'valid.png'), PNG); writeFileSync(join(directory, 'plain.txt'), 'plain');
    reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as { port: number };
    child = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', `127.0.0.1:${address.port}`], {
      env: { ...process.env, O8D_BRIDGE_KEY: 'asset-grant-fixture', O8D_EPOCH: 'asset-grant-fixture', O8D_NATIVE_SESSION_READS: '0', O8D_NATIVE_OWNED: '1', O8D_SESSION_DATA_DIR: directory, O8D_REQUEST_COUNTS_PATH: join(directory, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o8d startup timeout')), 10_000);
      child!.stdout!.on('data', chunk => { output += chunk.toString(); for (const line of output.split('\n')) try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve('http://' + value.listening); } } catch { /* Partial output. */ } });
      child!.once('error', reject);
    });
    for (mode of ['missing', 'malformed']) for (const route of routes) {
      const path = query(route, route === routes[1] ? 'valid.png' : join(directory, route === routes[0] ? 'plain.txt' : 'valid.png'));
      const init = { headers: { authorization: `Bearer ${reference.token}` } };
      const expected = await snapshot(await fetch(reference.url.replace('ws:', 'http:').replace('/ws', '') + path, init));
      const response = await fetch(origin + path, init);
      expect(response.headers.get('x-o8d-native'), mode + ':' + route).toBeNull();
      expect(await snapshot(response)).toEqual(expected);
    }
    expect(stderr + output + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(reference.token);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await reference?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
