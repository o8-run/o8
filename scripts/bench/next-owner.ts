/** Real Next/WS versus o8d/WS-owner replay and combined Linux process-tree RSS.
 * Uses owned Git, SQLite and saved-history fixtures; never starts providers. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { RecordedNextRequest } from '../lib/next-http-parity';

const root = mkdtempSync(join(tmpdir(), 'o8-next-owner-'));
const processLog = join(root, 'process.log');
const token = randomBytes(32).toString('hex');
const clock = resolve('tests/fixtures/next-owner-clock.cjs');
const binary = resolve(process.env.O8D_HTTP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d');
const probeBinary = resolve('tests/fixtures/next-client/target/debug/o8-next-http-probe');
const children: ChildProcess[] = [];
const runs = Number(process.env.O8_NEXT_OWNER_RUNS ?? 3);
const samples = Number(process.env.O8_NEXT_OWNER_SAMPLES ?? 20);
const output = process.env.O8_NEXT_OWNER_REPORT;
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', O8_DATA_DIR: undefined,
  WS_TOKEN: undefined, O8_WS_O8D: '0', O8_NEXT_OWNER_FIXTURE: '1', NEXT_TELEMETRY_DISABLED: '1',
  O8_NEXT_OWNER_REFERENCE_MODE: 'production',
  O8_WORKER_TOKEN: undefined, O8_API_TOKEN: undefined, O8_SPECTATOR_TOKEN: undefined };
environment.O8_NEXT_OWNER_PROVIDER_ROOT = join(root, 'provider-roots');
mkdirSync(environment.O8_NEXT_OWNER_PROVIDER_ROOT);

async function port() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  await new Promise<void>(done => socket.close(() => done()));
  return address.port;
}
function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
    const text = String(chunk).replaceAll(token, '[credential]').replace(/\/(?:home|root|Users)\/[^\s/]+/g, '[user-dir]');
    appendFileSync(processLog, text);
  });
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid!, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ } }, 3_000);
  await exited;
  clearTimeout(timer);
}
async function ready(origin: string, child: ChildProcess, path: string) {
  const deadline = performance.now() + 180_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture process exited before readiness');
    try {
      if ((await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch { /* compilation or startup */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Fixture readiness timed out');
}
async function native(origin: string, operations: unknown[], producerOrigin: string, repoPath: string) {
  const results: unknown[] = [];
  for (const operation of operations) results.push(...await nativeOne(origin, operation, producerOrigin, repoPath));
  return results;
}
async function nativeOne(origin: string, operation: unknown, producerOrigin: string, repoPath: string) {
  // Prime lazy handlers immediately before each operation in both cohorts so
  // the real client's five-second deadline measures warm handler behavior.
  const operations = [operation];
  for (const operation of operations) {
    const request = operation as { op: string; path?: string; query?: string[][] };
    if (request.op === 'review') {
      const response = await fetch(new URL('/api/orchestrator/review', origin), { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(120_000) });
      if (response.status !== 400) throw new Error('Review validation warmup failed');
      await response.arrayBuffer();
      const packetId = (operation as { body: { packetId: string } }).body.packetId;
      const state = await fetch(new URL(`/api/orchestrator/review-state?packetId=${encodeURIComponent(packetId)}`, origin), {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      if (!state.ok) throw new Error('Review state warmup failed');
      await state.arrayBuffer();
    }
    if (request.op !== 'get') continue;
    const url = new URL(request.path!, origin);
    for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Native warmup failed: ${url.pathname} (${response.status})`);
    await response.arrayBuffer();
  }
  if (operations.some(operation => ['exercise', 'websocket'].includes((operation as { op: string }).op))) {
    for (const path of ['/api/mobile/orchestrator/threads?limit=500', '/api/orchestrator/state',
      '/api/runtime/inventory?fresh=1', '/api/mobile/history?sessionKey=llm-chat%3Athoughts-long&limit=100&page=1',
      '/api/v2/chat-history?tabId=thoughts-long&limit=100',
      `/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repoPath)}&threadId=thoughts-long&backend=claude`, '/api/panel/ws-info']) {
      const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Native discovery warmup failed: ${path} (${response.status})`);
      await response.arrayBuffer();
    }
  }
  if (operations.some(operation => (operation as { op: string }).op === 'websocket')) {
    for (const [path, body] of [
      ['/api/command-center/snapshot?fresh=1', undefined], ['/api/mobile/inbox?fresh=1', undefined],
      ['/api/mobile/sync', { history: { sessionKey: 'llm-chat:thoughts-long', limit: 200 } }],
    ] as const) {
      for (let warmup = 0; warmup < 3; warmup++) {
        const response = await fetch(new URL(path, producerOrigin), { method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Producer warmup failed: ${path} (${response.status})`);
        const payload = await response.json();
        if (path.startsWith('/api/mobile/inbox') && warmup === 2 && payload.mode !== 'live') throw new Error('Inbox fixture did not become live');
      }
    }
  }
  const child = spawn(probeBinary, [origin], { env: { ...environment, O8_NEXT_API_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  let result = '';
  let diagnostic = '';
  child.stdout.on('data', chunk => { result += String(chunk); });
  child.stderr.on('data', chunk => { diagnostic += String(chunk).replaceAll(token, '[credential]').replace(/\/(?:home|root|Users)\/[^\s/]+/g, '[user-dir]'); });
  child.stdin.end(operations.map(operation => JSON.stringify(operation)).join('\n') + '\n');
  if ((await once(child, 'exit'))[0] !== 0) throw new Error(`Production native client probe failed: ${diagnostic.slice(-1_200)}`);
  return result.trim().split('\n').map(line => JSON.parse(line) as unknown);
}
function rss(pids: number[]) {
  const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      return [{ pid: Number(name), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
        kib: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) }];
    } catch { return []; }
  });
  const selected = new Set(pids);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  return rows.filter(row => selected.has(row.pid)).reduce((sum, row) => sum + row.kib, 0) / 1024;
}
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
function difference(left: unknown, right: unknown, path = ''): string {
  if (isDeepStrictEqual(left, right)) return '';
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const found = difference((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  const safe = /\.(?:id|auditApprovalId|mode|lastEventLabel|authority)$/.test(path);
  const scalar = (value: unknown) => value === undefined ? 'absent'
    : typeof value === 'string' || typeof value === 'number' || value === null ? JSON.stringify(value).slice(0, 160) : typeof value;
  return safe ? `${path} (reference ${scalar(left)}, candidate ${scalar(right)})` : path;
}

async function main() {
  const seed = join(root, 'seed');
  mkdirSync(seed);
  writeFileSync(join(seed, 'fixture-owner'), 'o8d-native-read/v1');
  await promisify(execFile)(process.execPath, ['--require', clock, '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx', 'scripts/next/seed-o8d.ts', seed, '--review'], {
    env: { ...environment, O8_NEXT_API_TOKEN: token }, maxBuffer: 1024 * 1024,
  });
  const repo = join(seed, 'fixture-repo');
  const head = (await promisify(execFile)('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const records: RecordedNextRequest[] = JSON.parse(readFileSync('tests/fixtures/next-http/requests.json', 'utf8')
    .replaceAll('$REPO', encodeURIComponent(repo)));
  records.push({ name: 'runtime inventory', path: '/api/runtime/inventory?fresh=1' },
    { name: 'runtime transcript', path: '/api/mobile/history?sessionKey=opencode-owned%3Anext-worker&limit=100&page=1' },
    { name: 'review state', path: '/api/orchestrator/review-state?packetId=next-review-reject' },
    { name: 'packet diff', path: '/api/lanes/next-review-reject/diff?maxBytes=524288' },
    { name: 'worktree diff', path: `/api/worktrees/diff?worktreePath=${encodeURIComponent(repo)}&baseBranch=main` },
    { name: 'dynamic steering', path: `/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=thoughts-long&backend=codex` });
  const report: { run: number; mode: string; rssMiB: number; routes: unknown[] }[] = [];
  const mismatches: string[] = [];
  for (let run = 1; run <= runs; run++) {
    let reference: unknown[] = [];
    const wsPort = await port();
    const apiPort = await port();
    for (const mode of ['next', 'owner']) {
      const data = join(root, `${mode}-${run}-unicode-π`);
      cpSync(seed, data, { recursive: true, preserveTimestamps: true });
      const origin = `http://127.0.0.1:${apiPort}`;
      const env: NodeJS.ProcessEnv = { ...environment, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'),
        CORTEX_IDE_REVIEW_REPO_ROOT: repo, O8_API_PORT: String(mode === 'owner' ? wsPort : apiPort), O8_WS_PORT: String(wsPort),
        O8_NEXT_HTTP_OWNER: mode === 'owner' ? '1' : '0', NEXT_ORIGIN: origin };
      env.O8_OWNED_OPENCODE_ROOT = join(seed, 'owned-opencode');
      writeFileSync(join(data, 'ws-port'), String(wsPort));
      const cohort: ChildProcess[] = [];
      console.log(`Fixture run ${run}: starting ${mode}`);
      if (mode === 'next') {
        const next = launch(['--require', clock, '.next/standalone/server.js'],
        { ...env, NODE_ENV: 'production', O8_NEXT_OWNER_FIXTURE_ROLE: 'next',
          PORT: String(apiPort), HOSTNAME: '127.0.0.1' });
        cohort.push(next);
        await ready(origin, next, '/api/panel/status');
        console.log('Next reference ready');
      }
      const owner = launch(['--require', clock, '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], env);
      cohort.push(owner);
      await ready(`http://127.0.0.1:${wsPort}`, owner, '/health');
      console.log('WS owner ready');
      if (mode === 'owner') {
        const daemon = spawn(binary, ['--experimental-http', '--listen', `127.0.0.1:${apiPort}`, '--data-dir', data,
          '--owner-upstream', `127.0.0.1:${wsPort}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(daemon); cohort.push(daemon);
        daemon.stdout!.resume(); daemon.stderr!.resume();
        await ready(origin, daemon, '/api/panel/ws-info');
      }
      const observed: unknown[] = [];
      const timings: unknown[] = [];
      const warm = await fetch(`${origin}/api/runtime/inventory?fresh=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      const warmed = await warm.json();
      if (warmed.generatedAt !== '2026-10-01T01:00:00.000Z') throw new Error(`Fixture clock inactive for ${mode}`);
      if (!warmed.agents.length) throw new Error(`Owned runtime inventory is empty for ${mode}`);
      // Each pair reuses its public ports after the previous cohort exits.
      for (const record of records) {
        console.log(`Replaying ${mode}: ${record.name}`);
        const credential = record.credential === 'absent' ? null : record.credential === 'invalid' ? 'fixture-invalid'
          : record.credential === 'read-only' ? 'o8ro_fixture' : token;
        const response = await fetch(`${origin}${record.path}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(120_000) });
        const body = await response.json().catch(() => { throw new Error(`Non-JSON ${mode} response: ${record.name} (${response.status})`); });
        if (record.name === 'runtime transcript' && !body.transcript?.length) throw new Error(`Owned runtime transcript is empty for ${mode}`);
        if (record.credential || response.status !== 200) {
          observed.push({ status: response.status, body });
          continue;
        }
        // State's own inventory cache warms asynchronously on its first read.
        if (record.name === 'mission') await new Promise(done => setTimeout(done, 2_000));
        const times = [];
        let captured = { status: response.status, body };
        for (let sample = -3; sample < samples; sample++) {
          const started = performance.now();
          const response = await fetch(`${origin}${record.path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
          const bytes = await response.arrayBuffer();
          if (sample >= 0) times.push(performance.now() - started);
          if (sample === samples - 1) captured = { status: response.status, body: JSON.parse(Buffer.from(bytes).toString()) };
        }
        observed.push(captured);
        timings.push({ route: record.name, p50: percentile(times, .5), p95: percentile(times, .95), samples: times });
      }
      const nativeReads = records.filter(record => ['runtime inventory', 'runtime transcript', 'review state', 'packet diff', 'worktree diff'].includes(record.name))
        .map(record => { const url = new URL(record.path, origin); return { op: 'get', path: url.pathname, query: [...url.searchParams] }; });
      observed.push(...await native(origin, [{ op: 'exercise' }, ...nativeReads, { op: 'websocket' }],
        mode === 'owner' ? `http://127.0.0.1:${wsPort}` : origin, repo));
      const target = { repoPath: repo, threadId: 'thoughts-long', id: 'fixture-native-send' };
      observed.push(...await native(origin, [
        { op: 'queue', method: 'POST', body: { ...target, intent: 'send-next', payload: { text: 'Fixture send', wireMessage: 'Fixture send', images: [],
          routing: { backend: 'claude', model: 'claude-code', effort: 'medium', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false } } } },
        { op: 'queue', method: 'PATCH', body: target }, { op: 'queue', method: 'DELETE', body: target },
        { op: 'review', body: { packetId: 'next-review-reject', reviewedHeadSha: head, approved: false, findings: [], clientMutationId: 'fixture-native-review' } },
      ], origin, repo));
      console.log(`Native probe completed: ${mode}`);
      if (mode === 'next') reference = observed;
      else if (!isDeepStrictEqual(reference, observed)) {
        for (let index = 0; index < reference.length; index++) {
          if (!isDeepStrictEqual(reference[index], observed[index])) mismatches.push(
            `run ${run}: ${records[index]?.name ?? `native operation ${index - records.length}`}${difference(reference[index], observed[index])}`);
        }
      }
      await new Promise(done => setTimeout(done, 2_000));
      report.push({ run, mode, rssMiB: rss(cohort.map(child => child.pid!)), routes: timings });
      console.log(`Combined ${mode} idle RSS: ${report.at(-1)!.rssMiB.toFixed(1)} MiB`);
      if (output) writeFileSync(output, JSON.stringify({ complete: false, mismatches, report }, null, 2));
      for (const child of cohort.reverse()) await stop(child);
    }
  }
  const result = { complete: true, node: process.versions.node,
    reference: 'Repository production standalone Next server plus ws-server',
    candidate: 'o8d plus ws-server with O8_NEXT_HTTP_OWNER=1; no Next process',
    fixture: { savedSessions: 3, savedMessages: 132, packets: 3, lanes: 3, ownedRuntimeSessions: 1 },
    warmups: 3, samples, comparedResponses: records.length + 11, mismatches, report };
  if (output) writeFileSync(output, JSON.stringify(result, null, 2));
  if (mismatches.length) throw new Error(`Next/owner parity failed: ${mismatches.join('; ')}`);
  console.log(`Next/owner parity passed; ${runs} paired runs, ${records.length + 11} responses per cohort`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Next owner fixture failed'); process.exitCode = 1; })
  .finally(async () => {
    for (const child of children.reverse()) await stop(child);
    try { cpSync(processLog, 'work/next-owner-process.log'); } catch { /* Startup may fail before output. */ }
    rmSync(root, { recursive: true, force: true });
  });
