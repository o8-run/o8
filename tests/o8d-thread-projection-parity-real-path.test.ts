import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { firstDifference, normalize, seedSessionFixture, send, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);
it('keeps linked-work key presence and the chosen machine name through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-thread-projection-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    writeFileSync(join(directory, 'computer-name'), 'Fixture computer\nignored line');
    for (const [id, branch] of [['thoughts-linked-branch', 'fixture-branch'], ['thoughts-linked-none', null]]) {
      writeFileSync(join(directory, 'chat-history', `${id}.json`), JSON.stringify({
        title: 'Fixture linkage', messages: [], backend: 'claude', repoBranch: branch, savedAt: '2026-10-01T00:00:00.000Z',
      }));
    }
    const path = '/api/mobile/orchestrator/threads?limit=500';
    server = await startSessionServer(directory, false, binary);
    const paths = [path, `${path}&offset=500`, `${path}&backend=invalid`, `${path}&archived=1`];
    const expectedResponses = [];
    for (const requestPath of paths) expectedResponses.push(await send(server, requestPath));
    const expected = expectedResponses[0];
    await server.stop(); server = undefined;
    server = await startSessionServer(directory, true, binary);
    const actual = await send(server, path);
    expect(actual.native).toBe(true);
    expect(firstDifference(normalize(expected.body), normalize(actual.body))).toBeNull();
    const body = actual.body as { threads: Array<Record<string, unknown>>; updatedAt: string | null };
    expect(body.updatedAt).toBe(body.threads.map(thread => thread.lastMessageAt as string).sort().at(-1) ?? null);
    expect(Object.keys(body).sort()).toMatchSnapshot('mobile thread envelope keys');
    for (let index = 1; index < paths.length; index++) {
      const response = await send(server, paths[index]);
      expect(response.native).toBe(true);
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

it('keeps null linkage when storage is absent and defers durable PR links to TypeScript', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-thread-linkage-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    const path = '/api/mobile/orchestrator/threads?limit=500';
    server = await startSessionServer(directory, true, binary);
    const db = new Database(join(directory, 'cortex-ide.db'));
    try {
      db.prepare(`INSERT INTO conversation_pr_context
        (thread_id, host, repository_id, pull_request_id, number, repository_name, kind, source, created_at)
        VALUES (?, 'github.com', 1, 10, 7, 'fixture/repository', 'context', 'operator', '2026-10-01T00:00:00.000Z')`).run('thoughts-review');
      // The saved mirror cannot reproduce the live broker fields. A durable
      // association must never receive a native marker, even if the broker fails.
      expect((await send(server, path)).native).toBe(false);
      db.exec('DROP TABLE conversation_pr_context');
      const absent = await send(server, path);
      expect(absent.native).toBe(true);
      const threads = (absent.body as { threads: Array<Record<string, unknown>> }).threads;
      expect(threads.length).toBeGreaterThan(0);
      for (const thread of threads) expect(thread.linkedWork).toBeNull();
    } finally { db.close(); }
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
