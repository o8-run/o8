/**
 * #2228 — local-first egress assertion through one full packet lifecycle.
 *
 * The process-level preload records TCP destinations before connect. It is
 * inherited by the fake runtime child through NODE_OPTIONS, so the same
 * recorder observes the o8 process (including Brain) and the worker process.
 * Unexpected non-loopback destinations are recorded and then blocked.
 */
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
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
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({
    ready: true,
    reason: 'local-egress-test',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'local-egress-test',
      apiBase: 'http://127.0.0.1:1',
      portSource: 'default',
      apiPortFilePresent: false,
    },
  })),
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const gateRoot = process.env.CORTEX_IDE_DATA_DIR!;
const root = realpathSync(mkdtempSync(join(gateRoot, 'local-egress-')));
const dataDir = join(root, 'data');
const ownedRoot = join(root, 'owned-qoder');
const fakeWorkerPath = join(root, 'qodercli');
const reportPath = join(root, 'egress.jsonl');
const renderedReportPath = join(root, 'egress-report.json');
const preloadPath = fileURLToPath(new URL('./fixtures/egress-assert-preload.mjs', import.meta.url));
mkdirSync(dataDir, { recursive: true });

const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_OWNED_QODER_ROOT',
  'O8_QODER_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_PACKAGED_APP',
  'O8_APFS_DEPENDENCY_IMAGES',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_LOCAL_INFERENCE_BASE_URL',
  'O8_LOCAL_CHAT_MODEL',
  'O8_TELEMETRY_OPT_IN',
  'O8_TELEMETRY_INGEST_URL',
  'O8_CRASH_REPORTS',
  'O8_EGRESS_REPORT_PATH',
  'O8_EGRESS_ALLOWED_ENDPOINTS',
  'O8_EGRESS_BLOCK_UNEXPECTED',
  'O8_EGRESS_SURFACE',
  'O8_EGRESS_PRELOAD_PID',
  'NODE_OPTIONS',
  'O8_WORKER_ENV_ALLOW',
] as const;
const priorEnv = new Map<string, string | undefined>();
for (const key of envKeys) priorEnv.set(key, process.env[key]);

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_QODER_ROOT = ownedRoot;
process.env.O8_QODER_BIN = fakeWorkerPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_PACKAGED_APP = '0';
process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
process.env.O8_TELEMETRY_OPT_IN = '0';
process.env.O8_CRASH_REPORTS = '0';
delete process.env.O8_TELEMETRY_INGEST_URL;
process.env.O8_EGRESS_REPORT_PATH = reportPath;
process.env.O8_EGRESS_BLOCK_UNEXPECTED = '1';
// Worker children inherit only allowlisted names (#4585): the egress preload and the fake
// worker's local-provider knobs. No provider credential is listed.
process.env.O8_WORKER_ENV_ALLOW = ['NODE_OPTIONS', 'O8_EGRESS_REPORT_PATH', 'O8_EGRESS_BLOCK_UNEXPECTED',
  'O8_EGRESS_ALLOWED_ENDPOINTS', 'O8_LOCAL_INFERENCE_BASE_URL', 'O8_LOCAL_CHAT_MODEL'].join(',');

const preloadArg = preloadPath.includes(' ')
  ? '--import="' + preloadPath + '"'
  : '--import=' + preloadPath;
process.env.NODE_OPTIONS = [priorEnv.get('NODE_OPTIONS'), preloadArg].filter(Boolean).join(' ');
await import(preloadPath);

writeFileSync(fakeWorkerPath, [
  '#!/usr/bin/env node',
  "const { execFileSync } = require('node:child_process');",
  "const fs = require('node:fs');",
  "process.env.O8_EGRESS_SURFACE = 'runtime-adapter';",
  "if (process.argv.includes('--version')) { process.stdout.write('qodercli 1.0.0\\n'); process.exit(0); }",
  "if (process.env.O8_EGRESS_PRELOAD_PID !== String(process.pid)) {",
  "  process.stderr.write('egress preload missing from worker process\\n');",
  "  process.exit(86);",
  "}",
  '(async () => {',
  "  const base = process.env.O8_LOCAL_INFERENCE_BASE_URL;",
  "  const response = await fetch(base + '/v1/chat/completions', {",
  "    method: 'POST',",
  "    headers: { 'content-type': 'application/json' },",
  "    body: JSON.stringify({ model: process.env.O8_LOCAL_CHAT_MODEL, messages: [{ role: 'user', content: 'worker local smoke' }] }),",
  '  });',
  "  if (!response.ok) throw new Error('local worker inference HTTP ' + response.status);",
  "  fs.writeFileSync('local-egress-proof.txt', 'worker stayed local\\n');",
  "  execFileSync('git', ['add', '-A'], { stdio: 'ignore' });",
  "  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', 'test: local egress proof'], { stdio: 'ignore' });",
  "  process.stdout.write(JSON.stringify({ type: 'completed', result: 'local worker complete' }) + '\\n');",
  '})().catch((error) => { process.stderr.write(String(error?.stack || error) + "\\n"); process.exit(87); });',
].join('\n'), 'utf8');
chmodSync(fakeWorkerPath, 0o755);

const { dispatch } = await import('@/lib/lane/commands');
const { getLane } = await import('@/lib/lane/registry');
const { POST: delegatePost } = await import('@/app/api/orchestrator/delegate/route');
const { approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { addRepo } = await import('@/lib/repos/registry');
const { callOpenRouter } = await import('@/lib/cortex/qa/llm/openrouter-adapter');
const { resetLocalInferenceProbeCacheForTests } = await import('@/lib/cortex/qa/llm/inference-route');
const { runTelemetryUpload } = await import('@/lib/telemetry/uploader');

let provider: Server | null = null;
let providerEndpoint = '';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, ['checkout', '-b', 'main']);
  git(seed, ['config', 'user.name', 'o8-test']);
  git(seed, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(seed, 'README.md'), 'local egress fixture\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  return repo;
}

async function waitFor<T>(read: () => T | null, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label + '.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface EgressRow {
  surface: string;
  host: string;
  port: number;
  endpoint: string;
  allowed: boolean;
  pid: number;
}

function readRows(): EgressRow[] {
  if (!existsSync(reportPath)) return [];
  return readFileSync(reportPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as EgressRow);
}

function aggregateReport() {
  const rows = readRows();
  const byKey = new Map<string, {
    surface: string;
    host: string;
    port: number;
    endpoint: string;
    allowed: boolean;
    count: number;
  }>();
  for (const row of rows) {
    const key = row.surface + '\u0000' + row.endpoint;
    const current = byKey.get(key);
    if (current) current.count += 1;
    else byKey.set(key, {
      surface: row.surface,
      host: row.host,
      port: row.port,
      endpoint: row.endpoint,
      allowed: row.allowed,
      count: 1,
    });
  }
  const contacts = [...byKey.values()].sort((a, b) =>
    a.surface.localeCompare(b.surface) || a.endpoint.localeCompare(b.endpoint));
  const knownSurfaces = ['dispatch', 'Brain', 'telemetry', 'updater', 'runtime-adapter', 'o8-server'];
  const surfaceTotals = Object.fromEntries(knownSurfaces.map((surface) => [
    surface,
    contacts.filter((entry) => entry.surface === surface).reduce((sum, entry) => sum + entry.count, 0),
  ]));
  return {
    schema: 'o8/local-egress-report/v1',
    providerEndpoint,
    contacts,
    surfaceTotals,
    unexpected: contacts.filter((entry) => !entry.allowed),
  };
}

beforeAll(async () => {
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['qoder'], defaultDispatchRuntime: 'qoder', defaultDispatchModel: '' });
  provider = createServer((req, res) => {
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/api/tags') {
      reply(200, { models: [{ name: 'local-test-model' }] });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      reply(200, { data: [{ id: 'local-test-model' }] });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume();
      reply(200, {
        model: 'local-test-model',
        choices: [{ message: { content: 'LOCAL_ONLY_OK' } }],
      });
      return;
    }
    reply(404, { error: 'not_found' });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('local provider did not expose a TCP port');
  providerEndpoint = '127.0.0.1:' + address.port;
  process.env.O8_LOCAL_INFERENCE_BASE_URL = 'http://' + providerEndpoint;
  process.env.O8_LOCAL_CHAT_MODEL = 'local-test-model';
  process.env.O8_EGRESS_ALLOWED_ENDPOINTS = [
    providerEndpoint,
    'localhost:' + address.port,
  ].join(',');
  resetLocalInferenceProbeCacheForTests();
});

afterAll(async () => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  await import('@/lib/db').then(({ closeDb }) => closeDb()).catch(() => {});
  if (provider?.listening) await new Promise<void>((resolve) => provider!.close(() => resolve()));
  vi.restoreAllMocks();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('#2228 local provider egress assertion', () => {
  it('fails closed and names the surface before an unexpected request can connect', async () => {
    const priorSurface = process.env.O8_EGRESS_SURFACE;
    process.env.O8_EGRESS_SURFACE = 'sabotage-probe';
    try {
      await expect(Promise.resolve().then(
        () => fetch('https://o8-egress-sabotage.invalid/probe'),
      )).rejects.toThrow(/O8_EGRESS_BLOCKED.*sabotage-probe.*o8-egress-sabotage\.invalid:443/);
    } finally {
      if (priorSurface === undefined) delete process.env.O8_EGRESS_SURFACE;
      else process.env.O8_EGRESS_SURFACE = priorSurface;
    }
    expect(readRows()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: 'sabotage-probe',
        endpoint: 'o8-egress-sabotage.invalid:443',
        allowed: false,
      }),
    ]));
    // The next test is the honest lifecycle baseline, so remove sabotage-only
    // evidence after proving the recorder catches it pre-connect.
    writeFileSync(reportPath, '', 'utf8');
  });

  it('dispatches, works, uses Brain, reviews, and merges with only the local provider as egress', async () => {
    const repoPath = makeRepo();
    await addRepo(realpathSync.native(repoPath));

    const delegatedResponse = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientMutationId: 'local-egress-' + Date.now(),
        prompt: 'Write local-egress-proof.txt, commit it, and stay on the configured local provider.',
        taskName: 'local egress lifecycle',
        repoPath,
        runtime: 'qoder',
      }),
    }));
    const delegated = await delegatedResponse.json() as {
      ok: boolean; laneId: string; packetId: string; error?: string;
    };
    expect(delegatedResponse.status).toBe(200);
    expect(delegated).toMatchObject({ ok: true });

    const workspacePath = await waitFor(
      () => getLane(delegated.laneId)?.worktreePath ?? null,
      'packet workspace',
    );
    const reviewedHeadSha = await waitFor(() => {
      const proof = join(workspacePath, 'local-egress-proof.txt');
      if (!existsSync(proof) || git(workspacePath, ['status', '--porcelain']) !== '') return null;
      return git(workspacePath, ['rev-parse', 'HEAD']);
    }, 'worker local-provider call and commit');

    const priorSurface = process.env.O8_EGRESS_SURFACE;
    process.env.O8_EGRESS_SURFACE = 'Brain';
    try {
      expect(await callOpenRouter('Return LOCAL_ONLY_OK exactly.', {
        model: 'local-test-model',
        fallbackModels: [],
      })).toBe('LOCAL_ONLY_OK');
    } finally {
      if (priorSurface === undefined) delete process.env.O8_EGRESS_SURFACE;
      else process.env.O8_EGRESS_SURFACE = priorSurface;
    }

    const telemetrySurface = process.env.O8_EGRESS_SURFACE;
    process.env.O8_EGRESS_SURFACE = 'telemetry';
    try {
      expect(await runTelemetryUpload()).toBe('disabled');
    } finally {
      if (telemetrySurface === undefined) delete process.env.O8_EGRESS_SURFACE;
      else process.env.O8_EGRESS_SURFACE = telemetrySurface;
    }

    const reviewRequested = await dispatch({ verb: 'request_review', laneId: delegated.laneId, actor: 'system' });
    expect(reviewRequested.ok).toBe(true);
    await submitPacketReview({
      packetId: delegated.packetId,
      approved: true,
      findings: [],
      reviewedHeadSha,
    });
    const merged = await approveAndMergePacket({
      packetId: delegated.packetId,
      expectedHeadSha: reviewedHeadSha,
      actor: 'user',
    });
    expect(merged.merged, merged.note).toBe(true);
    expect(readFileSync(join(repoPath, 'local-egress-proof.txt'), 'utf8')).toBe('worker stayed local\n');

    const report = aggregateReport();
    writeFileSync(renderedReportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.warn('[local-egress-baseline] ' + JSON.stringify(report));

    expect(report.contacts.some((entry) =>
      entry.surface === 'runtime-adapter' && entry.endpoint === providerEndpoint)).toBe(true);
    expect(report.contacts.some((entry) =>
      entry.surface === 'Brain' && entry.endpoint === providerEndpoint)).toBe(true);
    expect(report.surfaceTotals.telemetry).toBe(0);
    expect(
      report.unexpected,
      'unexpected outbound egress:\n' + JSON.stringify(report.unexpected, null, 2)
        + '\nfull report: ' + renderedReportPath,
    ).toEqual([]);
  }, 120_000);
});
