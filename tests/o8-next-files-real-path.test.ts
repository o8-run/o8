import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync, unlinkSync, truncateSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, it } from 'vitest';

let host: ChildProcess;
let origin = '';
let workspace = '';
const token = 'fixture-files-operator';
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--files'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stderr!.resume();
  const lines = createInterface({ input: host.stdout! });
  lines.on('line', line => {
    try { origin = (JSON.parse(line) as { origin?: string }).origin || origin; } catch { /* Private fixture diagnostics. */ }
  });
  const deadline = Date.now() + 25_000;
  while (!origin && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(origin).toBeTruthy();
  const data = await (await fetch(origin + '/api/mobile/orchestrator/threads', { headers: { authorization: `Bearer ${token}` } })).json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
  writeFileSync(join(workspace, 'viewer.ts'), "export const value = 42;\n");
}, 30_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
function read(path: string, credential = token) {
  return fetch(origin + '/api/panel/file-content?' + new URLSearchParams({ path, workspace, preview: '1' }), {
    headers: { authorization: `Bearer ${credential}` },
  });
}
function directory(path: string, credential = token) {
  return fetch(origin + '/api/panel/files?' + new URLSearchParams({ directory: path, workspace }), {
    headers: { authorization: `Bearer ${credential}` },
  });
}
it('browses directories through the authenticated read-only surface', async () => {
  mkdirSync(join(workspace, 'folder'));
  writeFileSync(join(workspace, 'folder', 'child.ts'), 'export const child = true;');
  const response = await directory('');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ entries: expect.arrayContaining([
    expect.objectContaining({ path: 'viewer.ts', kind: 'file' }),
    expect.objectContaining({ path: 'folder', kind: 'directory' }),
  ]) });
  expect(await (await directory('folder')).json()).toMatchObject({ entries: [expect.objectContaining({ path: join('folder', 'child.ts') })] });
  expect(await (await read(join('folder', 'child.ts'))).json()).toMatchObject({ content: 'export const child = true;' });
});
it('refuses native previews beyond 32 MiB while preserving desktop reads', async () => {
  const path = join(workspace, 'oversized.dat');
  writeFileSync(path, '');
  truncateSync(path, 32 * 1024 * 1024 + 1);
  expect((await read('oversized.dat')).status).toBe(413);
  const legacy = await fetch(origin + '/api/panel/file-content?' + new URLSearchParams({ path: 'oversized.dat', workspace }), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(legacy.status).toBe(200);
  expect((await legacy.json()).truncated).toBe(true);
  expect(statSync(path).size).toBe(32 * 1024 * 1024 + 1);
});
it('keeps empty files, refresh and missing-file errors distinct', async () => {
  writeFileSync(join(workspace, 'empty.txt'), '');
  expect(await (await read('empty.txt')).json()).toMatchObject({ content: '' });
  writeFileSync(join(workspace, 'empty.txt'), 'external edit');
  expect(await (await read('empty.txt')).json()).toMatchObject({ content: 'external edit' });
  expect((await read('missing.txt')).status).toBe(404);
});
it('bounds a 32 MiB file preview and leaves the source untouched', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 'x');
  writeFileSync(join(workspace, 'large.txt'), bytes);
  const data = await (await read('large.txt')).json() as { content: string; contentHash: string; truncated: boolean };
  expect(data.truncated).toBe(true);
  expect(data.content.length).toBeLessThan(100_100);
  expect(data.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(readFileSync(join(workspace, 'large.txt')).equals(bytes)).toBe(true);
});
it('marks binary bytes and retains raw-byte revision identity', async () => {
  const first = Buffer.from([0xff]); const second = Buffer.from([0xfe]);
  writeFileSync(join(workspace, 'binary.dat'), first);
  const opened = await (await read('binary.dat')).json() as { contentHash: string; binary: boolean };
  expect(opened.binary).toBe(true);
  expect(opened.contentHash).toBe(createHash('sha256').update(first).digest('hex'));
  writeFileSync(join(workspace, 'binary.dat'), second);
  expect((await (await read('binary.dat')).json()).contentHash).not.toBe(opened.contentHash);
  writeFileSync(join(workspace, 'nul.dat'), Buffer.from([65, 0, 66]));
  expect(await (await read('nul.dat')).json()).toMatchObject({ binary: true });
});
it('keeps operator authentication on file reads and browsing', async () => {
  expect((await read('viewer.ts', 'fixture-invalid')).status).toBe(401);
  expect((await directory('', 'fixture-invalid')).status).toBe(401);
});
it('refuses symlink, parent and absolute escapes without canary disclosure', async () => {
  const canary = ['owned', 'read-only', 'canary'].join('-');
  const outside = join(workspace, '..', 'outside.txt'); writeFileSync(outside, canary);
  const link = join(workspace, 'escape.txt'); symlinkSync(outside, link);
  for (const path of ['escape.txt', '../outside.txt', outside]) {
    const response = await read(path); expect(response.ok).toBe(false); expect(await response.text()).not.toContain(canary);
  }
  expect((await directory('..')).ok).toBe(false);
  expect(readFileSync(outside, 'utf8')).toBe(canary);
  unlinkSync(link);
});
