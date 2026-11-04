import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cliEntrypoint = join(root, 'cli', 'dist', 'o8.mjs');
const fixtureRoots = new Set<string>();

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ServeStatus {
  schema: 'o8/cli/serve-status/v1';
  running: boolean;
  healthy: boolean;
  pid: number;
  pgid: number;
  apiPort: number;
  wsPort: number;
  mode: 'development' | 'packaged';
  children: Array<{ role: 'api' | 'ws'; pid: number }>;
}

interface GovernedLoopFixture {
  dataDir: string;
  runtimeHome: string;
  ownedRuntimeRoot: string;
  fakeRuntimePath: string;
  capturePath: string;
  repoPath: string;
  initialHead: string;
}

interface ApiResult<T> {
  status: number;
  body: T;
  raw: string;
}

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string } | string;
}

interface MissionPacketStatus {
  id: string;
  status: string;
  blockedReason?: string | null;
  storageAdmission?: {
    state?: string;
    reason?: string | null;
  } | null;
}

interface MissionStatus {
  missionId: string;
  packets: MissionPacketStatus[];
}

interface RuntimeCapture {
  cwd: string;
  pid: number;
  ppid: number;
  argv: string[];
  commitSha: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRemoteBackedRepo(fixtureRoot: string): { repoPath: string; initialHead: string } {
  const originPath = join(fixtureRoot, 'origin.git');
  const seedPath = join(fixtureRoot, 'seed');
  const repoPath = join(fixtureRoot, 'repo');
  execFileSync('git', ['init', '--bare', originPath], { stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, seedPath], { stdio: 'pipe' });
  git(seedPath, 'checkout', '-b', 'main');
  writeFileSync(join(seedPath, 'README.md'), 'headless governed-loop fixture\n', 'utf8');
  git(seedPath, 'add', 'README.md');
  git(
    seedPath,
    '-c',
    'user.name=o8 test',
    '-c',
    'user.email=o8@test.invalid',
    'commit',
    '-m',
    'test: initialize governed loop fixture',
  );
  git(seedPath, 'push', '-u', 'origin', 'main');
  git(originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', originPath, repoPath], { stdio: 'pipe' });
  const canonicalRepoPath = realpathSync(repoPath);
  return { repoPath: canonicalRepoPath, initialHead: git(canonicalRepoPath, 'rev-parse', 'main') };
}

function writeFakeRuntime(fakeRuntimePath: string): void {
  writeFileSync(
    fakeRuntimePath,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('qodercli 1.0.0\\n');",
      '  process.exit(0);',
      '}',
      'const runGit = (args) => {',
      "  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });",
      '  if (result.status !== 0) {',
      "    process.stderr.write(`${result.stderr || result.stdout || 'git command failed'}\\n`);",
      '    process.exit(result.status || 1);',
      '  }',
      "  return String(result.stdout || '').trim();",
      '};',
      "writeFileSync('governed-loop.txt', 'completed by the daemon-owned runtime\\n', 'utf8');",
      "runGit(['add', 'governed-loop.txt']);",
      'runGit([',
      "  '-c', 'user.name=o8 test',",
      "  '-c', 'user.email=o8@test.invalid',",
      "  'commit', '-m', 'test: add governed loop receipt',",
      ']);',
      "const commitSha = runGit(['rev-parse', 'HEAD']);",
      'appendFileSync(',
      '  process.env.O8_FAKE_QODER_CAPTURE,',
      '  `${JSON.stringify({',
      '    cwd: process.cwd(),',
      '    pid: process.pid,',
      '    ppid: process.ppid,',
      '    argv: process.argv.slice(2),',
      '    commitSha,',
      '  })}\\n`,',
      ');',
      "process.stdout.write(`${JSON.stringify({ type: 'completed', result: 'fixture complete' })}\\n`);",
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeRuntimePath, 0o755);
}

function createFixture(): GovernedLoopFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-serve-governed-loop-'));
  fixtureRoots.add(fixtureRoot);
  const dataDir = join(fixtureRoot, 'data');
  const runtimeHome = join(fixtureRoot, 'runtime-home');
  const ownedRuntimeRoot = join(fixtureRoot, 'owned-runtime');
  const fakeRuntimePath = join(fixtureRoot, 'qodercli');
  const capturePath = join(fixtureRoot, 'runtime-capture.jsonl');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeHome, '.qoder'), { recursive: true });
  writeFileSync(join(runtimeHome, '.qoder', 'settings.json'), '{}\n', 'utf8');
  writeFakeRuntime(fakeRuntimePath);
  const { repoPath, initialHead } = createRemoteBackedRepo(fixtureRoot);
  return {
    dataDir,
    runtimeHome,
    ownedRuntimeRoot,
    fakeRuntimePath,
    capturePath,
    repoPath,
    initialHead,
  };
}

function cliEnv(fixture: Pick<GovernedLoopFixture, 'dataDir' | 'runtimeHome' | 'ownedRuntimeRoot' | 'fakeRuntimePath' | 'capturePath'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.runtimeHome,
    O8_DATA_DIR: fixture.dataDir,
    CORTEX_IDE_DATA_DIR: fixture.dataDir,
    O8_SERVE_ROOT: root,
    O8_QODER_BIN: fixture.fakeRuntimePath,
    O8_OWNED_QODER_ROOT: fixture.ownedRuntimeRoot,
    O8_FAKE_QODER_CAPTURE: fixture.capturePath,
    O8_SKIP_PRELAUNCH_TYPECHECK: '1',
    O8_STORAGE_RESERVE_RATIO: '0.000001',
    O8_STORAGE_RESERVE_FLOOR_GB: '0.001',
    O8_APFS_DEPENDENCY_IMAGES: '0',
    O8_WORKER_SANDBOX: '0',
    O8_WORKER_TOKEN: '',
    O8_WORKER_PACKET_ID: '',
  };
  delete env.NODE_OPTIONS;
  return env;
}

function runCli(
  args: string[],
  fixture: Pick<GovernedLoopFixture, 'dataDir' | 'runtimeHome' | 'ownedRuntimeRoot' | 'fakeRuntimePath' | 'capturePath'>,
  timeout = 75_000,
): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliEntrypoint, ...args], {
      cwd: root,
      env: cliEnv(fixture),
      timeout,
    }, (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processTree(rootPid: number): Array<{ pid: number; ppid: number; command: string }> {
  if (process.platform === 'win32') return [];
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = output.split('\n').flatMap((row) => {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }];
  });
  const byParent = new Map<number, typeof rows>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const descendants: typeof rows = [];
  const pending = [...(byParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next) continue;
    descendants.push(next);
    pending.push(...(byParent.get(next.pid) ?? []));
  }
  const rootRow = rows.find((row) => row.pid === rootPid);
  return rootRow ? [rootRow, ...descendants] : descendants;
}

async function waitForPidsToExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50); });
  }
  return pids.every((pid) => !processAlive(pid));
}

function readServeLog(dataDir: string): string {
  const logPath = join(dataDir, 'logs', 'serve.log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

async function apiRequest<T>(
  status: ServeStatus,
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ApiResult<T>> {
  const response = await fetch(`http://127.0.0.1:${status.apiPort}${path}`, {
    method: init?.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: JSON.parse(raw) as T,
    raw,
  };
}

async function waitForPacketStatus(
  fixture: GovernedLoopFixture,
  serveStatus: ServeStatus,
  token: string,
  missionId: string,
  packetId: string,
  expectedStatus: string,
  timeoutMs = 90_000,
): Promise<MissionPacketStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastPacket: MissionPacketStatus | undefined;
  while (Date.now() < deadline) {
    const response = await apiRequest<OperatorResponse<MissionStatus>>(
      serveStatus,
      token,
      `/api/orchestrator/status?missionId=${encodeURIComponent(missionId)}`,
    );
    if (response.status === 200 && response.body.ok && response.body.result) {
      lastPacket = response.body.result.packets.find((packet) => packet.id === packetId);
      if (lastPacket?.status === expectedStatus) return lastPacket;
      if (lastPacket?.status === 'blocked' || lastPacket?.status === 'failed') {
        throw new Error(
          `Packet reached ${lastPacket.status}: ${lastPacket.blockedReason ?? 'no reason'}\n${readServeLog(fixture.dataDir)}`,
        );
      }
      if (lastPacket?.storageAdmission?.state === 'held') {
        throw new Error(
          `Packet storage admission held: ${lastPacket.storageAdmission.reason ?? 'no reason'}\n${readServeLog(fixture.dataDir)}`,
        );
      }
    }
    await new Promise((resolveWait) => { setTimeout(resolveWait, 250); });
  }
  throw new Error(
    `Timed out waiting for ${packetId} -> ${expectedStatus}; last=${JSON.stringify(lastPacket)}\n${readServeLog(fixture.dataDir)}`,
  );
}

function readRuntimeCapture(path: string): RuntimeCapture {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected one fake runtime launch, found ${lines.length}.`);
  return JSON.parse(lines[0]!) as RuntimeCapture;
}

describe.sequential('o8 serve headless governed loop real path', () => {
  beforeAll(() => {
    const fixture = createFixture();
    execFileSync(process.execPath, [join(root, 'cli', 'esbuild.config.mjs')], {
      cwd: root,
      env: cliEnv(fixture),
    });
  });

  afterAll(async () => {
    for (const fixtureRoot of fixtureRoots) {
      const dataDir = join(fixtureRoot, 'data');
      const cleanupFixture = {
        dataDir,
        runtimeHome: join(fixtureRoot, 'runtime-home'),
        ownedRuntimeRoot: join(fixtureRoot, 'owned-runtime'),
        fakeRuntimePath: join(fixtureRoot, 'qodercli'),
        capturePath: join(fixtureRoot, 'runtime-capture.jsonl'),
      };
      await runCli(['serve', 'stop'], cleanupFixture, 15_000);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('creates, dispatches, reviews, and merges one packet without a window, then reaps the daemon tree', async () => {
    const fixture = createFixture();
    let stopped = false;
    try {
      const started = await runCli(['serve'], fixture);
      expect(started.code, `${started.stderr}\n${readServeLog(fixture.dataDir)}`).toBe(0);
      const serveStatus = JSON.parse(started.stdout) as ServeStatus;
      expect(serveStatus).toMatchObject({
        schema: 'o8/cli/serve-status/v1',
        running: true,
        healthy: true,
        mode: 'development',
      });
      expect(serveStatus.children.map((child) => child.role).sort()).toEqual(['api', 'ws']);

      const initialDaemonTree = processTree(serveStatus.pid);
      expect(initialDaemonTree.map((entry) => entry.pid)).toEqual(expect.arrayContaining([
        serveStatus.pid,
        ...serveStatus.children.map((child) => child.pid),
      ]));
      expect(initialDaemonTree.map((entry) => entry.command).join('\n')).not.toMatch(/(?:^|[\s/])tauri(?:[\s/]|$)|o8\.app/i);

      const token = readFileSync(join(fixture.dataDir, 'ws-token'), 'utf8').trim();
      const repoRegistration = await apiRequest<{ repo?: { localPath?: string } }>(
        serveStatus,
        token,
        '/api/panel/repos',
        { method: 'POST', body: { action: 'add', localPath: fixture.repoPath } },
      );
      expect(repoRegistration.status, repoRegistration.raw).toBe(201);
      expect(repoRegistration.body.repo?.localPath).toBe(fixture.repoPath);

      const created = await apiRequest<OperatorResponse<{
        missionId: string;
        packets: Array<{ id: string }>;
      }>>(serveStatus, token, '/api/orchestrator/create-mission', {
        method: 'POST',
        body: {
          repoPath: fixture.repoPath,
          issues: [{
            number: 92029,
            title: 'Prove one headless governed loop',
            body: 'Write governed-loop.txt and commit it.',
            url: '',
          }],
          runtime: 'qoder',
          dispatcher: { surface: 'operator', id: 'integration-test' },
          launchContext: {
            source: 'cli',
            presentation: 'split',
            repoContext: 'transient',
            caller: 'integration-test',
          },
          clientMutationId: randomUUID(),
        },
      });
      expect(created.status, created.raw).toBe(201);
      expect(created.body.ok, created.raw).toBe(true);
      const missionId = created.body.result?.missionId;
      const packetId = created.body.result?.packets[0]?.id;
      expect(missionId).toBeTruthy();
      expect(packetId).toBeTruthy();

      const dispatched = await apiRequest<OperatorResponse<{ initiated?: boolean; missionId?: string }>>(
        serveStatus,
        token,
        '/api/orchestrator/dispatch',
        {
          method: 'POST',
          body: { missionId, wait: false, idempotencyKey: randomUUID() },
        },
      );
      expect(dispatched.status, dispatched.raw).toBe(200);
      expect(dispatched.body).toMatchObject({ ok: true, result: { initiated: true, missionId } });

      await waitForPacketStatus(fixture, serveStatus, token, missionId!, packetId!, 'awaiting_review');
      const runtimeCapture = readRuntimeCapture(fixture.capturePath);
      expect(runtimeCapture.cwd).toContain(`.cortex-worktrees/packet-${packetId}`);
      expect(runtimeCapture.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
      expect(processTree(serveStatus.pid).map((entry) => entry.pid)).toContain(runtimeCapture.ppid);

      const reviewed = await apiRequest<OperatorResponse<{ recorded?: boolean; reviewedHeadSha?: string }>>(
        serveStatus,
        token,
        '/api/orchestrator/review',
        {
          method: 'POST',
          body: {
            packetId,
            approved: true,
            findings: [],
            clientMutationId: randomUUID(),
          },
        },
      );
      expect(reviewed.status, reviewed.raw).toBe(200);
      expect(reviewed.body).toMatchObject({ ok: true, result: { recorded: true } });

      const merged = await apiRequest<OperatorResponse<{ merged?: boolean; mergeCommit?: string }>>(
        serveStatus,
        token,
        '/api/orchestrator/merge',
        {
          method: 'POST',
          body: { packetId, idempotencyKey: randomUUID() },
        },
      );
      expect(merged.status, merged.raw).toBe(200);
      expect(merged.body).toMatchObject({ ok: true, result: { merged: true } });

      const canonicalHead = git(fixture.repoPath, 'rev-parse', 'main');
      expect(canonicalHead).not.toBe(fixture.initialHead);
      expect(readFileSync(join(fixture.repoPath, 'governed-loop.txt'), 'utf8'))
        .toBe('completed by the daemon-owned runtime\n');
      const ancestry = spawnSync(
        'git',
        ['merge-base', '--is-ancestor', runtimeCapture.commitSha, canonicalHead],
        { cwd: fixture.repoPath, stdio: 'pipe' },
      );
      expect(ancestry.status).toBe(0);

      const ownedPids = [...new Set([
        ...initialDaemonTree.map((entry) => entry.pid),
        ...processTree(serveStatus.pid).map((entry) => entry.pid),
        runtimeCapture.pid,
      ])];
      const stopResult = await runCli(['serve', 'stop'], fixture, 15_000);
      stopped = true;
      expect(stopResult.code, stopResult.stderr).toBe(0);
      expect(JSON.parse(stopResult.stdout)).toMatchObject({ stopped: true, pid: serveStatus.pid });
      expect(await waitForPidsToExit(ownedPids, 5_000)).toBe(true);
      expect(ownedPids.filter(processAlive)).toEqual([]);
      expect(existsSync(join(fixture.dataDir, 'serve.pid'))).toBe(false);
      expect(existsSync(join(fixture.dataDir, 'serve-state.json'))).toBe(false);
    } finally {
      if (!stopped) await runCli(['serve', 'stop'], fixture, 15_000);
    }
  }, 200_000);
});
