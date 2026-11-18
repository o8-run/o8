import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startParityReference } from './fixtures/ws-parity-server';
import { beforeAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { firstDifference, normalize, seedSessionFixture, send } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);
async function startFixture(directory: string, native: boolean, binary: string) {
  const server = await startParityReference({ directory, nativeHttp: true, o8d: native, nativeSessionReads: native, binary,
    preload: resolve('tests/fixtures/o8d-thread-list-preload.cjs') });
  await server.stopNext();
  return { ...server, origin: server.url.replace('ws:', 'http:').replace('/ws', '') };
}
async function localSend(server: Awaited<ReturnType<typeof startFixture>>, path: string) {
  const response = await fetch(server.origin + path, { headers: { authorization: `Bearer ${server.token}` } });
  return { status: response.status, body: await response.json(), native: response.headers.get('x-o8d-native') === '1',
    localStage: response.headers.get('x-o8d-local-stage') === 'threads/1' };
}
it('keeps linked-work key presence and the chosen machine name through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-thread-projection-')));
  let server: Awaited<ReturnType<typeof startFixture>> | undefined;
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'computer-name'), 'Fixture computer\nignored line');
    for (const [id, branch] of [['thoughts-linked-branch', 'fixture-branch'], ['thoughts-linked-none', null]]) {
      writeFileSync(join(directory, 'chat-history', `${id}.json`), JSON.stringify({
        title: 'Fixture linkage', messages: [], backend: 'claude', repoBranch: branch, savedAt: '2026-10-01T00:00:00.000Z',
      }));
    }
    const path = '/api/mobile/orchestrator/threads?limit=500';
    server = await startFixture(directory, false, binary);
    const paths = [path, `${path}&offset=500`, `${path}&backend=invalid`, `${path}&archived=1`];
    const expectedResponses = [];
    for (const requestPath of paths) expectedResponses.push(await send(server, requestPath));
    const expected = expectedResponses[0];
    await server.stop(); server = undefined;
    server = await startFixture(directory, true, binary);
    // Node cached the original choice at launch. The per-request grant must
    // carry that authority even after the saved name changes.
    writeFileSync(join(directory, 'computer-name'), 'Different saved computer');
    const actual = await localSend(server, path);
    expect(actual.localStage).toBe(true);
    expect(actual.native).toBe(false);
    expect(firstDifference(normalize(expected.body), normalize(actual.body))).toBeNull();
    const body = actual.body as { threads: Array<Record<string, unknown>>; updatedAt: string | null };
    expect(body.updatedAt).toBe(body.threads.map(thread => thread.lastMessageAt as string).sort().at(-1) ?? null);
    expect(Object.keys(body).sort()).toMatchSnapshot('mobile thread envelope keys');
    for (let index = 1; index < paths.length; index++) {
      const response = await localSend(server, paths[index]);
      expect(response.native || response.localStage).toBe(true);
      expect(firstDifference(normalize(expectedResponses[index].body), normalize(response.body))).toBeNull();
      if (index === 1) expect(response.body).toEqual({ threads: [], updatedAt: null });
      if (index === 2) expect(response.body).toEqual({ threads: [] });
      if (index === 3) expect(response.body).toHaveProperty('archivedIds');
    }
    expect(body.threads.find(thread => thread.id === 'thoughts-linked-none')?.linkedWork).toBeNull();
    expect(body.threads.find(thread => thread.id === 'thoughts-linked-branch')?.linkedWork).toEqual({
      pullRequests: { total: 0, open: 0, merged: 0, closed: 0 }, branches: 1,
    });
    for (const thread of body.threads) {
      expect(thread.machineDisplayName).toBe('Fixture computer');
      expect(thread).toHaveProperty('linkedWork');
      if (thread.status !== 'busy') expect(thread).not.toHaveProperty('runStartedAt');
    }
    expect(Object.keys(body.threads[0]).sort()).toMatchSnapshot('mobile thread response keys');
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it('keeps null linkage on storage refusal and composes durable PR links with the Node authority', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-thread-linkage-')));
  let server: Awaited<ReturnType<typeof startFixture>> | undefined;
  try {
    await seedSessionFixture(directory);
    const path = '/api/mobile/orchestrator/threads?limit=500';
    writeFileSync(join(directory, 'thread-list-control.json'), JSON.stringify({ prThrows: true }));
    server = await startFixture(directory, true, binary);
    const db = new Database(join(directory, 'cortex-ide.db'));
    try {
      db.prepare(`INSERT INTO conversation_pr_context
        (thread_id, host, repository_id, pull_request_id, number, repository_name, kind, source, created_at)
        VALUES (?, 'github.com', 1, 10, 7, 'fixture/repository', 'context', 'operator', '2026-10-01T00:00:00.000Z')`).run('thoughts-review');
      // The local stage can read associations, while the Node broker still
      // supplies live fields. A broker failure leaves those fields absent.
      const linked = await localSend(server, path);
      expect(linked.localStage).toBe(true);
      expect(linked.native).toBe(false);
      expect(linked.body.threads.find((row: { id: string }) => row.id === 'thoughts-review').linkedWork.pullRequests.total).toBe(1);
      db.exec('DROP TABLE conversation_pr_context');
      const absent = await send(server, path);
      expect(absent.native).toBe(false);
      const threads = (absent.body as { threads: Array<Record<string, unknown>> }).threads;
      expect(threads.length).toBeGreaterThan(0);
      for (const thread of threads) expect(thread.linkedWork).toBeNull();
    } finally { db.close(); }
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
