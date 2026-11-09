import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { buildCliBundle } from './fixtures/cli-bundle';
import { startParityReference } from './fixtures/ws-parity-server';

// `o8 task create` sends POST /api/tasks and `o8 doctor --reap` sends POST /api/lanes/reap. With
// Next stopped the WS listener must run both itself: the first was registered for GET only (405),
// and the second had no handler at all after the dead-route sweep removed it while doctor still
// called it. The gate grants workers GET on /api/tasks and nothing on /api/lanes/reap, so each
// POST needs the operator bearer, and its outcome shows up in the persisted task pool and lane.
it.skipIf(process.platform === 'win32')('creates tasks and reaps stale lanes natively with Next stopped, operator-only (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-task-lane-mutations-')));
  const cliEntry = join(directory, 'o8-cli.mjs');
  const device = 'task-lane-fixture-device-0123456789abcdef';
  const worker = 'task-lane-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    await buildCliBundle(cliEntry, 'test-fixture');
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const apiPort = new URL(origin).port;
    const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token };

    // A dead pid for the lane's session, so the owner probe reads it as gone.
    const exited = spawn(process.execPath, ['-e', '']);
    const deadPid = exited.pid!;
    await new Promise(resolve => exited.on('close', resolve));

    const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      const { execFileSync } = require('node:child_process');
      const { mkdirSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      (async () => {
        const root = process.env.CORTEX_IDE_DATA_DIR;
        const repoPath = join(root, 'repo');
        mkdirSync(repoPath);
        const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
        git('init', '-q', '-b', 'main', repoPath);
        git('-C', repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
        await require('./src/lib/repos/registry.ts').addRepo(repoPath);
        const { createLane, updateLane } = require('./src/lib/lane/registry.ts');
        const worktreePath = join(root, 'stale-worktree');
        mkdirSync(worktreePath);
        writeFileSync(join(worktreePath, 'keep.txt'), 'worktree content\\n');
        const lane = createLane({ repoPath, branch: 'fixture-stale-lane', runtime: 'codex',
          worktreePath, sessionKey: 'codex-live:${deadPid}' });
        updateLane(lane.id, { status: 'running', lastHeartbeatAt: Date.now() - 10 * 60_000 }, 'system');
        console.log('seed ' + JSON.stringify({ repoPath, laneId: lane.id, worktreePath }));
        require('./src/lib/db/index.ts').closeDb();
      })().catch(error => { console.error(error); process.exit(1); });
    `], { env });
    const { repoPath, laneId, worktreePath } = JSON.parse(seeded.stdout.split('\n')
      .find(line => line.startsWith('seed '))!.slice(5)) as { repoPath: string; laneId: string; worktreePath: string };

    const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    // Every lesser credential is refused before either handler, with local markers forged as well.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const [path, body] of [['/api/tasks', { title: 'Refused task', repoPath }], ['/api/lanes/reap', { force: true }]] as const) {
      expect((await post(path, body, forged)).status, `${path} anonymous`).toBe(401);
      expect((await post(path, body, { ...forged, authorization: `Bearer ${device}` })).status, `${path} device`).toBe(403);
      expect((await post(path, body, { ...forged, authorization: `Bearer ${worker}` })).status, `${path} worker`).toBe(403);
    }

    const cli = async (...args: string[]) => {
      const childEnv = { ...process.env };
      delete childEnv.O8_WORKER_TOKEN;
      delete childEnv.O8_WORKER_PACKET_ID;
      const child = spawn(process.execPath, [cliEntry, ...args], { env: { ...childEnv,
        HOME: directory, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
        O8_API_PORT: apiPort, O8_API_TOKEN: server!.token }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    };

    // o8 task create: the task lands in the pool, read back through the native task read.
    const created = await cli('task', 'create', '--title', 'Native task fixture', '--repo', repoPath, '--json');
    expect(created.code, created.stderr).toBe(0);
    const createdTask = JSON.parse(created.stdout) as { task?: { id?: string }; packetId?: string };
    const taskId = createdTask.task?.id ?? createdTask.packetId;
    expect(taskId).toBeTruthy();
    const operator = { authorization: `Bearer ${server.token}` };
    const pool = await (await fetch(`${origin}/api/tasks?includeDone=true`, { headers: operator })).json() as { tasks: Array<{ id: string; title: string }> };
    expect(pool.tasks.find(task => task.id === taskId)).toMatchObject({ title: 'Native task fixture' });

    // o8 doctor --reap lists the stale lane without touching it; --force reaps it.
    const listed = await cli('doctor', '--reap', '--json');
    const listedReap = (JSON.parse(listed.stdout) as { reap?: { candidates: Array<{ lane: { id: string } }>; reaped: unknown[] } }).reap;
    expect(listedReap?.candidates.map(candidate => candidate.lane.id), listed.stderr).toContain(laneId);
    expect(listedReap?.reaped).toEqual([]);
    const lanesBefore = await (await fetch(`${origin}/api/lanes?active=false`, { headers: operator })).json() as { lanes: Array<{ id: string; status: string }> };
    expect(lanesBefore.lanes.find(lane => lane.id === laneId)?.status).toBe('running');

    const forced = await cli('doctor', '--reap', '--force', '--json');
    const forcedReap = (JSON.parse(forced.stdout) as { reap?: { reaped: Array<{ candidate: { lane: { id: string } } }> } }).reap;
    expect(forcedReap?.reaped.map(item => item.candidate.lane.id), forced.stderr).toContain(laneId);
    const lanesAfter = await (await fetch(`${origin}/api/lanes?active=false`, { headers: operator })).json() as { lanes: Array<{ id: string; status: string }> };
    const reaped = lanesAfter.lanes.find(lane => lane.id === laneId);
    expect(reaped?.status).toBeDefined();
    expect(reaped?.status).not.toBe('running');
    // The reaper only moves the lane; the worktree and its content stay.
    expect(existsSync(join(worktreePath, 'keep.txt'))).toBe(true);
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
