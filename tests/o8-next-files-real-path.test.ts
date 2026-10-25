import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  const lines = createInterface({ input: host.stdout! });
  for await (const line of lines) {
    try { origin = (JSON.parse(line) as { origin?: string }).origin || origin; } catch { continue; }
    if (origin) { lines.close(); break; }
  }
  expect(origin).toBeTruthy();
  const response = await fetch(origin + '/api/mobile/orchestrator/threads', { headers: { authorization: `Bearer ${token}` } });
  const data = await response.json() as { threads: Array<{ repoPath: string }> };
  workspace = realpathSync(data.threads[0].repoPath);
  writeFileSync(join(workspace, 'viewer.md'), '# Fixture\n');
}, 30_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
function read(path: string, credential = token) {
  return fetch(origin + '/api/panel/file-content?' + new URLSearchParams({ path, workspace }), {
    headers: { authorization: `Bearer ${credential}` },
  });
}
function save(content: string, expectedHash: string, force = false, path = 'viewer.md') {
  return fetch(origin + '/api/v2/files', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ workspace, path, content, expectedHash, force }) });
}
it('loads and saves through the production middleware and guarded file routes', async () => {
  const response = await read('viewer.md');
  expect(response.status).toBe(200);
  const data = await response.json() as { content: string; contentHash: string };
  expect(data.content).toBe('# Fixture\n');
  const saved = await save('# Saved\n', data.contentHash);
  expect(saved.status).toBe(200);
  expect(readFileSync(join(workspace, 'viewer.md'), 'utf8')).toBe('# Saved\n');
});
it('retains external content on conflict and supports explicit overwrite', async () => {
  const response = await read('viewer.md');
  expect(response.status).toBe(200);
  const { contentHash } = await response.json() as { contentHash: string };
  writeFileSync(join(workspace, 'viewer.md'), '# External\n');
  const conflict = await save('# Draft\n', contentHash);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: 'changed-on-disk', content: '# External\n' });
  expect(readFileSync(join(workspace, 'viewer.md'), 'utf8')).toBe('# External\n');
  expect((await save('# Draft\n', contentHash, true)).status).toBe(200);
  expect(readFileSync(join(workspace, 'viewer.md'), 'utf8')).toBe('# Draft\n');
});
it('preserves authentication, missing-file and traversal refusals', async () => {
  expect((await read('viewer.md', 'fixture-invalid')).status).toBe(401);
  expect((await read('missing.md')).status).toBe(404);
  expect((await read('../outside.md')).ok).toBe(false);
  expect((await save('escape', '', false, '../outside.md')).ok).toBe(false);
});
it('keeps empty files distinct from errors and exposes the existing truncation flag', async () => {
  writeFileSync(join(workspace, 'empty.txt'), '');
  expect(await (await read('empty.txt')).json()).toMatchObject({ content: '' });
  writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(100_001));
  expect(await (await read('large.txt')).json()).toMatchObject({ truncated: true });
});

it('hashes raw binary revisions and refuses a stale save despite identical lossy text', async () => {
  const first = Buffer.from([0xff]);
  const second = Buffer.from([0xfe]);
  writeFileSync(join(workspace, 'binary.dat'), first);
  const opened = await (await read('binary.dat')).json() as { contentHash: string; binary?: boolean };
  expect(opened.contentHash).toBe(createHash('sha256').update(first).digest('hex'));
  expect(opened.binary).toBe(true);
  writeFileSync(join(workspace, 'binary.dat'), second);
  const changed = await (await read('binary.dat')).json() as { contentHash: string };
  expect(changed.contentHash).not.toBe(opened.contentHash);
  expect((await save('replacement', opened.contentHash, false, 'binary.dat')).status).toBe(409);
  expect(readFileSync(join(workspace, 'binary.dat'))).toEqual(second);
  // The write route must use the same raw-byte hash, including when it matches.
  expect((await save('replacement', changed.contentHash, false, 'binary.dat')).status).toBe(200);
  expect(readFileSync(join(workspace, 'binary.dat'), 'utf8')).toBe('replacement');
});

it('marks NUL-containing UTF-8 as binary and keeps Unicode text hashes compatible', async () => {
  writeFileSync(join(workspace, 'nul.dat'), Buffer.from([65, 0, 66]));
  expect(await (await read('nul.dat')).json()).toMatchObject({ binary: true });
  const text = 'é🙂\n';
  writeFileSync(join(workspace, 'unicode.txt'), text);
  const data = await (await read('unicode.txt')).json() as { binary: boolean; contentHash: string };
  expect(data.binary).toBe(false);
  expect(data.contentHash).toBe(createHash('sha256').update(text).digest('hex'));
  expect((await save(text + 'saved', data.contentHash, false, 'unicode.txt')).status).toBe(200);
});
