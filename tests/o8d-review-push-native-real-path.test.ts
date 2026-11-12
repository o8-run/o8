import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let repo: string;
let remote: string;
const device = 'review-push-fixture-device';
const spectator = 'review-push-fixture-spectator';
const worker = 'review-push-fixture-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function push(body: unknown = { workspace: repo }, token = server.token, relay = false) {
  return fetch(`${origin}/api/review/push`, { method: 'POST',
    headers: { ...forged, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(relay ? { 'x-o8-relay-forward': '1' } : {}) }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  repo = join(server.directory, 'repo');
  remote = join(server.directory, 'remote.git');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'file'), 'initial\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'init', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  writeFileSync(join(server.directory, 'broadcast-spectator-tokens'), createHash('sha256').update(spectator).digest('hex'));
}, 120_000);
afterAll(async () => { await server?.stop(); });

it('keeps push operator-only despite forged local headers and relay markers', async () => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [spectator, 403]] as const) {
      expect((await push(undefined, token, relay)).status).toBe(status);
    }
  }
  expect(git(repo, 'ls-remote', 'origin')).toBe('');
});

it.each([false, true])('keeps another native API request below 750 ms during a delayed real push (lock=%s)', async (contended) => {
  // The marker is emitted inside receive-pack, so timing cannot accidentally probe before push.
  const marker = join(remote, contended ? 'hook-started-lock' : 'hook-started');
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\ntouch "${marker}"\nsleep 3\n`, { mode: 0o755 });
  writeFileSync(join(repo, 'file'), `delayed ${contended}\n`);
  git(repo, 'commit', '-qam', 'delayed');
  // Warm the cheap registered handler before measuring WS event-loop availability.
  const read = () => fetch(`${origin}/api/setup/identity`, { headers: { authorization: `Bearer ${server.token}` } });
  expect((await read()).status).toBe(200);
  const holder = contended ? spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    process.stdin.once('data', () => { db.close(); process.exit(); });
  `, createRequire(import.meta.url).resolve('better-sqlite3'), join(server.directory, '.provider-keys.lock')]) : null;
  const closed = holder ? once(holder, 'close') : null;
  if (holder) await once(holder.stdout, 'data');
  let finished = false;
  const pushing = push().finally(() => { finished = true; });
  try {
    if (holder) {
      await delay(250);
      const started = performance.now();
      const response = await read();
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      process.stdout.write(`native request while lock held: ${elapsed.toFixed(1)} ms\n`);
      holder.stdin.end('release');
      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(750);
    }
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && !finished && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), 'real remote pre-receive hook started').toBe(true);
    expect(finished).toBe(false);
    const started = performance.now();
    const response = await read();
    await response.arrayBuffer();
    const elapsed = performance.now() - started;
    process.stdout.write(`native request during delayed push: ${elapsed.toFixed(1)} ms\n`);
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(750);
    expect(finished).toBe(false);
  } finally {
    holder?.stdin.end('release');
    if (closed) await closed;
    const response = await pushing;
    expect([response.status, await response.json()]).toEqual([200, {
      ok: true, branch: 'main', upstream: 'origin/main', message: 'Pushed main to origin/main',
    }]);
  }
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'refs/heads/main'));
  // Existing-upstream branch uses plain push and preserves the same response.
  const again = await push();
  expect([again.status, await again.json()]).toEqual([200, {
    ok: true, branch: 'main', upstream: 'origin/main', message: 'Pushed main to origin/main',
  }]);
}, 30_000);

it('preserves invalid JSON, detached HEAD, missing remote and rejected push errors', async () => {
  const invalid = await fetch(`${origin}/api/review/push`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{' });
  expect([invalid.status, await invalid.json()]).toEqual([400, { error: 'Invalid JSON body' }]);
  git(repo, 'checkout', '--detach', '-q');
  const detached = await push();
  expect([detached.status, await detached.json()]).toEqual([400, { error: 'Cannot push from detached HEAD' }]);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'remote', 'remove', 'origin');
  const missing = await push();
  expect([missing.status, await missing.json()]).toEqual([400, { error: 'No git remote configured for this workspace' }]);
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho fixture-rejection >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(repo, 'file'), 'rejected\n');
  git(repo, 'commit', '-qam', 'rejected');
  const rejected = await push();
  expect(rejected.status).toBe(500);
  expect((await rejected.json()).error).toContain('fixture-rejection');
  expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(git(remote, 'rev-parse', 'refs/heads/main'));
});

it('keeps native requests below 750 ms when the provider launch lock is contended', async () => {
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
  const holder = spawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setTimeout(() => { db.close(); }, 3000);
  `, sqlite, join(server.directory, '.provider-keys.lock')]);
  const closed = once(holder, 'close');
  await once(holder.stdout, 'data');
  const pushing = push();
  try {
    await delay(100);
    const started = performance.now();
    const response = await fetch(`${origin}/api/setup/identity`, { headers: { authorization: `Bearer ${server.token}` } });
    await response.arrayBuffer();
    const elapsed = performance.now() - started;
    process.stdout.write(`native request during provider lock contention: ${elapsed.toFixed(1)} ms\n`);
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(750);
  } finally {
    await pushing;
    await closed;
  }
}, 15_000);

it('forwards the Next push entry to the native owner', async () => {
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  try {
    const { POST } = await import('@/app/api/review/push/route');
    const response = await POST(new Request(`${origin}/api/review/push`, {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{',
    }));
    expect([response.status, await response.json()]).toEqual([400, { error: 'Invalid JSON body' }]);
    const refused = await POST(new Request(`${origin}/api/review/push`, {
      method: 'POST', headers: { authorization: `Bearer ${worker}`, 'content-type': 'application/json' }, body: '{',
    }));
    // Direct Next handler execution would parse the malformed JSON and return 400.
    // The owner runs its bearer gate first and refuses this request with 403.
    expect(refused.status).toBe(403);
  } finally { vi.unstubAllEnvs(); }
});

it('keeps the fresh child credential argument denial', async () => {
  const sentinel = 'fixture-denied-provider-material';
  writeFileSync(join(server.directory, '.env.local'), `OPENAI_API_KEY=${sentinel}\n`);
  try {
    git(repo, 'checkout', '-qb', sentinel);
    const response = await push();
    expect([response.status, await response.json()]).toEqual([500, {
      error: 'Prepared child arguments contain revoked or unauthorized provider credentials.',
    }]);
    writeFileSync(join(server.directory, '.env.local'), '');
    const remembered = await push();
    expect([remembered.status, await remembered.json()]).toEqual([500, {
      error: 'Prepared child arguments contain revoked or unauthorized provider credentials.',
    }]);
  } finally { git(repo, 'checkout', '-q', 'main'); writeFileSync(join(server.directory, '.env.local'), ''); }
});

it('kills the push and its hook when the native client aborts', async () => {
  const marker = join(remote, 'abort-started');
  const completed = join(remote, 'abort-completed');
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\ntouch "${marker}"\nsleep 3\ntouch "${completed}"\n`, { mode: 0o755 });
  const controller = new AbortController();
  const pushing = fetch(`${origin}/api/review/push`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: repo }), signal: controller.signal }).catch(() => null);
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker)).toBe(true);
    controller.abort();
    await pushing;
    await delay(3300);
    expect(existsSync(completed)).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(git(remote, 'rev-parse', 'refs/heads/main'));
  } finally { controller.abort(); await pushing; }
}, 25_000);


it('kills the helper, Git and hook at a configurable push deadline without moving the remote', async () => {
  const marker = join(remote, 'timeout-pids');
  const completed = join(remote, 'timeout-completed');
  const previous = git(remote, 'rev-parse', 'refs/heads/main');
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho "$$ $PPID" > "${marker}"\nsleep 3\ntouch "${completed}"\n`, { mode: 0o755 });
  const { runPushChild } = await import('@/lib/providers/child-process');
  const pushing = runPushChild(repo, new AbortController().signal, 2000);
  const rejected = expect(pushing).rejects.toThrow('Push timed out');
  try {
    const deadline = Date.now() + 1800;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    expect(existsSync(marker), 'hook reached before timeout').toBe(true);
    const hookPids = readFileSync(marker, 'utf8').trim().split(/\s+/).map(Number);
    const helper = Number(execFileSync('ps', ['-p', String(hookPids[0]), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    const group = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(line => Number(line.split(/\s+/)[1]) === helper);
    expect(group.some(line => /git push/.test(line))).toBe(true);
    const pids = [...new Set([helper, ...hookPids, ...group.map(line => Number(line.split(/\s+/)[0]))])];
    await rejected;
    await delay(3300);
    for (const pid of pids) {
      let state = '';
      try { state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); } catch { /* reaped */ }
      expect(state === '' || state.startsWith('Z'), `process ${pid} stopped`).toBe(true);
    }
    expect(existsSync(completed)).toBe(false);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(previous);
  } finally { await rejected; }
}, 15_000);
