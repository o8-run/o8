import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it, onTestFinished, vi } from 'vitest';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until<T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
/** Fails fast instead of hanging when a run never settles. */
function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Still pending: ${label}`)), ms))]);
}

// The digest's Codex run is a real child process tree. The stand-in is shaped like the
// production launcher: a parent that ignores SIGTERM and a descendant that holds stdout open.
// A disconnected request and an overdue run must both settle promptly and end the whole tree,
// so a client retry never overlaps a run that is still going.
it.skipIf(process.platform === 'win32')('ends the digest Codex run tree when the request disconnects or the deadline passes', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-digest-limits-')));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const codex = join(directory, 'codex');
  writeFileSync(codex, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.130.0"; exit 0; fi',
    "trap '' TERM",
    'sleep 600 &',
    `echo "$$ $!" > "${directory}/tree.tmp" && mv "${directory}/tree.tmp" "${directory}/run-$$.pids"`,
    'wait',
  ].join('\n'));
  chmodSync(codex, 0o755);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify([{ path: repo }]));
  const saved = { ...process.env };
  const seen = new Set<string>();
  const trees: number[][] = [];
  onTestFinished(() => {
    for (const pid of trees.flat()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  });
  const nextRun = async () => {
    const tree = await until(() => {
      const file = readdirSync(directory).find(name => name.endsWith('.pids') && !seen.has(name));
      if (!file) return undefined;
      seen.add(file);
      return readFileSync(join(directory, file), 'utf8').trim().split(' ').map(Number);
    }, 'codex run started');
    trees.push(tree);
    expect(tree.every(alive)).toBe(true);
    return tree;
  };
  const ended = (tree: number[], label: string) => until(() => (tree.some(alive) ? undefined : true), label);

  Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
    O8_CODEX_BIN: codex, WS_TOKEN: 'digest-limits-fixture-token' });
  delete process.env.O8_DATA_DIR;
  vi.resetModules();
  const route = await import('@/app/api/orchestrator/digest/route');
  const { digest } = await import('@/lib/orchestrator/auto-compact');

  // The client goes away mid-run: the request settles at once and the whole run tree ends.
  const client = new AbortController();
  const pending = route.POST(new NextRequest('http://127.0.0.1/api/orchestrator/digest', {
    method: 'POST', signal: client.signal,
    headers: { authorization: 'Bearer digest-limits-fixture-token', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Fixture material to digest.', repoPath: repo }),
  }));
  const cancelled = await nextRun();
  client.abort();
  expect((await within(pending, 1_500, 'cancelled request')).status).toBe(500);
  await ended(cancelled, 'cancelled run tree stopped');

  // A run that overstays its deadline is reported as a timeout, then its tree ends.
  const overdue = digest('Fixture material to digest.', repo, { timeoutMs: 500 });
  const timedOut = await nextRun();
  await expect(within(overdue, 2_000, 'overdue digest')).rejects.toThrow('Codex summary timed out after 500ms');
  await ended(timedOut, 'overdue run tree stopped');
}, 60_000);
