import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const fileRace = vi.hoisted(() => ({ before: null as null | ((input: { name?: string; writeUnknown?: boolean }) => (() => void) | undefined) }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
    const options = args[2];
    const restore = options && typeof options.input === 'string' && options.input.startsWith('{')
      ? fileRace.before?.(JSON.parse(options.input)) : undefined;
    try { return actual.spawnSync(...args); } finally { restore?.(); }
  } };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-receipt-settlement-')));
const data = join(root, 'data');
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
let route = await import('@/app/api/panel/managed-runs/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { closeDb } = await import('@/lib/db');
const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim();
const marker = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const receiptDirectory = join(realpathSync(tmpdir()), 'o8-worker-runs', marker, 'logs', 'run');
let server: Server | undefined;
let socket: string | undefined;
let socketRoot: string | undefined;
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function request(body?: unknown, token = getOrCreateWsToken()) {
  return new Request('http://localhost/api/panel/managed-runs', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function registration(id: string, exitReceiptPath?: unknown) {
  return { action: 'register', id, session: `cortex-run-${id}`, command: 'fixture check', cwd: root,
    mode: 'detach', ...(exitReceiptPath === undefined ? {} : { exitReceiptPath }) };
}
function persisted(id: string) {
  return JSON.parse(readFileSync(join(data, 'managed-runs.json'), 'utf8')).runs
    .find((run: { id: string }) => run.id === id);
}
async function reconcile(id: string) {
  const result = await route.GET(request());
  expect(result.status, await result.clone().text()).toBe(200);
  return (await result.json()).runs.find((run: { id: string }) => run.id === id);
}
afterAll(async () => {
  if (socket) { try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  closeDb();
  for (const path of [root, join(tmpdir(), 'o8-worker-runs', marker), socketRoot]) {
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe.skipIf(!tmux || process.platform === 'win32')('managed-run receipt paths through CLI, API and persisted reconciliation', () => {
  it('settles a packet-bound detached owned-worker command with its actual exit code after hydration', async () => {
    const cwd = join(root, '.cortex-worktrees', 'packet-receipt');
    mkdirSync(cwd, { recursive: true });
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'receipt-mission', repoPath: root,
      packets: [{ id: 'receipt', referenceLabel: 'RECEIPT', title: 'receipt fixture', summary: 'receipt fixture',
        status: 'running', queueState: 'queued', releaseState: 'pending', runtime: 'codex',
        dependencyPacketIds: [], dependencyLabels: [], blockedReason: null, operatorStopped: false,
        lane: null, review: null, workspaceTargetPath: cwd, branchTarget: 'fixture/receipt' }] });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    socketRoot = mkdtempSync('/tmp/o8-rs-');
    socket = join(socketRoot, 'sock');
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`);
    chmodSync(join(bin, 'tmux'), 0o700);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keepalive', 'sleep 90']);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    server = createServer(async (incoming, outgoing) => {
      if (incoming.url?.startsWith('/api/lanes')) {
        outgoing.setHeader('content-type', 'application/json');
        outgoing.end(JSON.stringify({ lanes: [{ id: 'receipt-lane', packetId: 'receipt', worktreePath: cwd }] }));
        return;
      }
      let body = '';
      for await (const chunk of incoming) body += chunk;
      const result = await route.POST(new Request(`http://localhost${incoming.url}`, { method: 'POST',
        headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' }, body }));
      outgoing.writeHead(result.status, { 'content-type': 'application/json' }).end(await result.text());
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const bundle = join(root, 'o8.mjs');
    await build({ alias: cliBundleAlias, entryPoints: ['cli/src/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: '"fixture"' },
      banner: { js: "import { createRequire as __o8_require } from 'node:module'; const require = __o8_require(import.meta.url); globalThis.require = require;" } });
    const child = spawn(process.execPath, [bundle, 'run', '--detach', '--', process.execPath, '-e', 'process.exit(7)'], {
      cwd, env: { ...process.env, O8_API_PORT: String(address.port), O8_API_TOKEN: '',
        O8_WORKER_TOKEN: mintPacketWorkerToken('receipt'), O8_WORKER_PACKET_ID: 'receipt',
        O8_OWNED_RUN_MARKER: marker, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    expect(code, stderr).toBe(0);
    const { id } = JSON.parse(stdout);
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    await expect.poll(() => existsSync(exitReceiptPath)).toBe(true);
    expect(readFileSync(exitReceiptPath, 'utf8')).toBe('7');
    expect(persisted(id)).toMatchObject({ packetId: 'receipt', mode: 'detach', exitReceiptPath, status: 'running' });
    // A new registry module must recover the path from disk, not a live CLI object.
    delete (globalThis as { __o8ManagedRuns?: unknown }).__o8ManagedRuns;
    delete (globalThis as { __o8ManagedRunsHydrated?: boolean }).__o8ManagedRunsHydrated;
    vi.resetModules();
    route = await import('@/app/api/panel/managed-runs/route');
    await expect.poll(async () => {
      const response = await route.GET(request());
      return (await response.json()).runs.find((run: { id: string }) => run.id === id)?.exitCode;
    }).toBe(7);
    expect(persisted(id)).toMatchObject({ status: 'finished', exitCode: 7, exitReceiptPath });
    expect(existsSync(join(data, 'logs', 'run', `${id}.exit`))).toBe(false);
  });

  it('retains an unknown exit in the registered directory when a detached wrapper vanishes', async () => {
    const id = 'missingReceipt';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    expect((await route.POST(request(registration(id, exitReceiptPath)))).status).toBe(200);
    expect(await reconcile(id)).toMatchObject({ status: 'gone', exitCode: null });
    expect(readFileSync(exitReceiptPath, 'utf8')).toBe('signal:UNKNOWN');
    expect(existsSync(join(data, 'logs', 'run', `${id}.exit`))).toBe(false);
  });

  it.each([false, true])('recovers a data-directory receipt with explicit path=%s', async (explicit) => {
    const id = explicit ? 'explicitReceipt' : 'legacyReceipt';
    const exitReceiptPath = join(data, 'logs', 'run', `${id}.exit`);
    mkdirSync(join(data, 'logs', 'run'), { recursive: true });
    writeFileSync(exitReceiptPath, '23');
    expect((await route.POST(request(registration(id, explicit ? exitReceiptPath : undefined)))).status).toBe(200);
    expect(await reconcile(id)).toMatchObject({ status: 'finished', exitCode: 23 });
  });

  it('recovers the registered receipt for an externally settled run', async () => {
    const id = 'boundReceipt';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    writeFileSync(exitReceiptPath, '19');
    const body = { ...registration(id, exitReceiptPath), settlementBinding: {
      schema: 'o8/managed-run-settlement-binding/v1', executionKey: id, generation: 1,
      branch: 'fixture/receipt', providerSessionId: '00000000-0000-4000-8000-000000000001',
      profileDigest: 'a'.repeat(64), receiptId: id,
    } };
    const response = await route.POST(request(body));
    expect(response.status, await response.clone().text()).toBe(200);
    const registered = (await response.json()).run;
    expect(await reconcile(id)).toMatchObject({ status: 'settling', exitCode: 19 });
    const sealed = await route.POST(request({ action: 'settlement', id, receiptId: id,
      bindingDigest: registered.settlement.bindingDigest, sequence: 1, state: 'quiet',
      providerSessionId: body.settlementBinding.providerSessionId }));
    expect(sealed.status, await sealed.clone().text()).toBe(200);
    expect(persisted(id)).toMatchObject({ status: 'finished', exitCode: 19, exitReceiptPath });
  });

  it('rejects registration replay with a changed receipt path', async () => {
    const id = 'replayReceipt';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    const body = registration(id, exitReceiptPath);
    expect((await route.POST(request(body))).status).toBe(200);
    expect((await route.POST(request(body))).status).toBe(200);
    const response = await route.POST(request(registration(id, join(data, 'logs', 'run', `${id}.exit`))));
    expect(response.status).toBe(409);
    expect(persisted(id)).toMatchObject({ exitReceiptPath });
  });

  it('revalidates a receipt replaced with an outside symlink before reconciliation', async () => {
    const id = 'replacedReceipt';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    expect((await route.POST(request(registration(id, exitReceiptPath)))).status).toBe(200);
    const outside = join(root, 'replaced-outside.exit');
    writeFileSync(outside, '31');
    symlinkSync(outside, exitReceiptPath);
    expect(await reconcile(id)).toMatchObject({ status: 'gone', exitCode: null });
    expect(readFileSync(outside, 'utf8')).toBe('31');
  });

  it.each([false, true])('refuses a directory swap between validation and file access with writeUnknown=%s', async (writeUnknown) => {
    const id = writeUnknown ? 'raceWrite' : 'raceRead';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    expect((await route.POST(request(registration(id, exitReceiptPath)))).status).toBe(200);
    const outside = join(root, id);
    mkdirSync(outside);
    if (!writeUnknown) writeFileSync(join(outside, `${id}.exit`), '31');
    let swapped = false;
    fileRace.before = (input) => {
      if (input.name !== `${id}.exit` || input.writeUnknown !== writeUnknown) return;
      swapped = true;
      renameSync(receiptDirectory, `${receiptDirectory}-saved`);
      symlinkSync(outside, receiptDirectory, 'dir');
      return () => {
        rmSync(receiptDirectory);
        renameSync(`${receiptDirectory}-saved`, receiptDirectory);
      };
    };
    try {
      expect(await reconcile(id)).toMatchObject({ status: 'gone', exitCode: null });
      expect(swapped).toBe(true);
      if (writeUnknown) expect(existsSync(join(outside, `${id}.exit`))).toBe(false);
      else expect(readFileSync(join(outside, `${id}.exit`), 'utf8')).toBe('31');
    } finally { fileRace.before = null; }
  });

  it('does not block reconciliation if a registered leaf is replaced with a FIFO', async () => {
    const id = 'replacedFifo';
    const exitReceiptPath = join(receiptDirectory, `${id}.exit`);
    expect((await route.POST(request(registration(id, exitReceiptPath)))).status).toBe(200);
    execFileSync('mkfifo', [exitReceiptPath]);
    expect(await reconcile(id)).toMatchObject({ status: 'gone', exitCode: null });
  });

  it.each(['outside', 'traversal', 'wrong-marker', 'wrong-file', 'non-string', 'symlink', 'fifo', 'oversized'])('refuses a forged %s receipt path before persistence', async (variant) => {
    const id = `forged${variant.replaceAll('-', '')}`;
    let exitReceiptPath: unknown = join(root, `${id}.exit`);
    if (variant === 'traversal') exitReceiptPath = `${receiptDirectory}/../../../../${id}.exit`;
    if (variant === 'wrong-marker') exitReceiptPath = join(tmpdir(), 'o8-worker-runs', 'invalid', 'logs', 'run', `${id}.exit`);
    if (variant === 'wrong-file') exitReceiptPath = join(receiptDirectory, 'other.exit');
    if (variant === 'non-string') exitReceiptPath = 42;
    if (variant === 'fifo' || variant === 'oversized') {
      exitReceiptPath = join(receiptDirectory, `${id}.exit`);
      if (variant === 'fifo') execFileSync('mkfifo', [exitReceiptPath as string]);
      else writeFileSync(exitReceiptPath as string, '1'.repeat(65));
    }
    if (variant === 'symlink') {
      exitReceiptPath = join(receiptDirectory, `${id}.exit`);
      mkdirSync(receiptDirectory, { recursive: true });
      symlinkSync(join(root, 'outside.exit'), exitReceiptPath as string);
      writeFileSync(join(root, 'outside.exit'), '17');
    }
    const response = await route.POST(request({ ...registration(id, exitReceiptPath), packetId: 'receipt' }, mintPacketWorkerToken('receipt')));
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'invalid_exit_receipt_path' });
    expect(persisted(id)).toBeUndefined();
  });
});
