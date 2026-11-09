import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';

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

// The digest's Codex run is a real child process (a stand-in codex that never answers).
// A disconnected request and an overdue run must both end it, not leave it running for a retry to stack on.
it.skipIf(process.platform === 'win32')('ends the digest Codex run when the request disconnects or the deadline passes', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-digest-limits-')));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const codex = join(directory, 'codex');
  writeFileSync(codex, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.130.0"; exit 0; fi',
    `echo $$ > "${directory}/run-$$.pid"`,
    'exec sleep 600',
  ].join('\n'));
  chmodSync(codex, 0o755);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify([{ path: repo }]));
  const saved = { ...process.env };
  const pids: number[] = [];
  const nextRun = async () => {
    const pid = await until(() => {
      const file = readdirSync(directory)
        .find(name => name.startsWith('run-') && !pids.includes(Number(readFileSync(join(directory, name), 'utf8'))));
      return file ? Number(readFileSync(join(directory, file), 'utf8')) : undefined;
    }, 'codex run started');
    pids.push(pid);
    return pid;
  };
  try {
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      O8_CODEX_BIN: codex, WS_TOKEN: 'digest-limits-fixture-token' });
    delete process.env.O8_DATA_DIR;
    vi.resetModules();
    const route = await import('@/app/api/orchestrator/digest/route');
    const { digest } = await import('@/lib/orchestrator/auto-compact');

    // The client goes away mid-run: the route's Codex child is stopped and the request settles.
    const client = new AbortController();
    const pending = route.POST(new NextRequest('http://127.0.0.1/api/orchestrator/digest', {
      method: 'POST', signal: client.signal,
      headers: { authorization: 'Bearer digest-limits-fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Fixture material to digest.', repoPath: repo }),
    }));
    const cancelled = await nextRun();
    expect(alive(cancelled)).toBe(true);
    client.abort();
    expect((await pending).status).toBe(500);
    await until(() => (alive(cancelled) ? undefined : true), 'cancelled run stopped');

    // A run that overstays its deadline is stopped and reported as a timeout.
    const overdue = digest('Fixture material to digest.', repo, { timeoutMs: 500 });
    const timedOut = await nextRun();
    await expect(overdue).rejects.toThrow('Codex summary timed out after 500ms');
    await until(() => (alive(timedOut) ? undefined : true), 'overdue run stopped');
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
