import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

const root = mkdtempSync(join(getDataDir(), 'codex-native-worker-'));
const binaryRoot = mkdtempSync(join(tmpdir(), 'o8-codex-native-bin-'));
const sessions = join(root, 'sessions');
const packageRoot = join(binaryRoot, 'node_modules', '@openai', 'codex');
const entry = join(packageRoot, 'bin', 'codex.js');
const binary = join(binaryRoot, 'codex');
const receipts = join(root, 'receipts.jsonl');
const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
const native = join(packageRoot, 'vendor', target, 'bin', 'codex');
mkdirSync(join(packageRoot, 'bin'), { recursive: true });
mkdirSync(join(packageRoot, 'vendor', target, 'bin'), { recursive: true });
writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
  name: '@openai/codex', version: '0.163.0', bin: { codex: 'bin/codex.js' }, type: 'module',
}));
writeFileSync(native, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const threadId = 'worker-' + process.pid;
const receipt = {
  kind: 'native', pid: process.pid, cwd: process.cwd(), home: process.env.CODEX_HOME, threadId, args,
};
if (!args.some(arg => arg.startsWith('sandbox_mode='))) {
  appendFileSync(${JSON.stringify(receipts)}, JSON.stringify(receipt) + '\\n');
}
let writeDenied = false;
try { writeFileSync(process.cwd() + '/sandbox-write-probe', 'fixture'); } catch { writeDenied = true; }
console.log(JSON.stringify({ type: 'fixture.start', receipt, writeDenied }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: threadId } }));
await new Promise(resolve => setTimeout(resolve, args.includes('Reply for hold-worker') ? 30_000 : 2_000));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
writeFileSync(entry, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv[2] === 'app-server') {
  appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ kind: 'discovery', home: process.env.CODEX_HOME }) + '\\n');
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line); if (!message.id) return;
    const result = message.method === 'model/list' ? { data: [{ model: 'gpt-6.1-sol', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] }
      : message.method === 'config/read' ? { config: {} } : {};
    console.log(JSON.stringify({ id: message.id, result }));
  }).on('close', () => process.exit(0));
} else {
if (!process.argv.includes('--version')) appendFileSync(${JSON.stringify(receipts)},
  JSON.stringify({ kind: 'npm-launcher', pid: process.pid }) + '\\n');
const child = spawn(${JSON.stringify(native)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });
child.on('exit', code => process.exit(code ?? 1));
}
`);
chmodSync(native, 0o700);
chmodSync(entry, 0o700);
if (process.platform !== 'win32') symlinkSync(entry, binary);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', sessions);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');

const { launchOwnedCodexSession, getOwnedCodexRuntimeTail, interruptOwnedCodexSession } = await import('@/lib/codex/owned');
const { registerRuntimeIdentity, selectRuntimeIdentity } = await import('@/lib/runtime/identity-catalog');

function calls(): Array<Record<string, unknown>> {
  return existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

async function launch(name: string, readOnly = false) {
  const cwd = join(root, name);
  const home = join(root, `${name}-home`);
  mkdirSync(cwd);
  mkdirSync(home);
  execFileSync('git', ['init', '-q', cwd]);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: name, configHomeRef: home });
  await selectRuntimeIdentity('codex', identity.id);
  const result = await launchOwnedCodexSession({ cwd, prompt: `Reply for ${name}`, model: 'gpt-6.1-sol', effort: 'medium', workMode: readOnly ? 'read-only' : undefined });
  expect(result, result.note).toMatchObject({ ok: true });
  const sessionPath = join(sessions, result.surfaceId.slice('codex-owned:'.length), 'session.json');
  return { cwd, home, sessionPath, surfaceId: result.surfaceId };
}

async function settled(worker: Awaited<ReturnType<typeof launch>>) {
  await vi.waitFor(async () => {
    await getOwnedCodexRuntimeTail(worker.surfaceId);
    const saved = JSON.parse(readFileSync(worker.sessionPath, 'utf8')) as OwnedSessionRecord;
    expect(saved.activeRun).toBeUndefined();
    const run = saved.recentRuns[0];
    expect(run.outcome, run.outcome === 'failed' ? readFileSync(run.stderrPath, 'utf8') : undefined).toBe('finished');
  }, { timeout: 15_000, interval: 50 });
  return { ...worker, saved: JSON.parse(readFileSync(worker.sessionPath, 'utf8')) as OwnedSessionRecord };
}

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  rmSync(binaryRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('native Codex worker launch through the owned store', () => {
  it('removes the npm launcher process without sharing cwd, credentials or thread between two workers', async () => {
    // Admission serializes creation; the worker processes themselves overlap.
    const first = await launch('worker-a');
    const second = await launch('worker-b');
    const workers = await Promise.all([settled(first), settled(second)]);
    expect(calls().filter(call => call.kind === 'npm-launcher')).toHaveLength(0);
    const started = calls().filter(call => call.kind === 'native');
    expect(started).toHaveLength(2);
    expect(new Set(started.map(call => call.pid)).size).toBe(2);
    expect(new Set(workers.map(worker => worker.saved.threadId)).size).toBe(2);
    for (const worker of workers) {
      expect(started).toContainEqual(expect.objectContaining({ cwd: worker.saved.repoPath, home: worker.home, threadId: worker.saved.threadId }));
      const call = started.find(call => call.home === worker.home)!;
      expect(call.args).toEqual(expect.arrayContaining(['exec', '--json', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-6.1-sol', 'model_reasoning_effort=medium']));
      expect(worker.saved.identity?.configHomeRef).toBe(worker.home);
    }
  }, 30_000);

  it.skipIf(process.platform !== 'darwin')('keeps the native worker inside the forced read-only OS sandbox', async () => {
    const worker = await settled(await launch('read-only', true));
    const raw = readFileSync(worker.saved.recentRuns[0].stdoutPath, 'utf8');
    const proof = raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'fixture.start');
    expect(proof).toMatchObject({ writeDenied: true, receipt: { cwd: worker.saved.repoPath, home: worker.home, threadId: worker.saved.threadId } });
    expect(proof.receipt.args).toContain('sandbox_mode="danger-full-access"');
    expect(calls()).toContainEqual(expect.objectContaining({ kind: 'discovery', home: worker.home }));
    expect(existsSync(join(worker.cwd, 'sandbox-write-probe'))).toBe(false);
  }, 30_000);

  it('stops the native process through its persisted owned identity', async () => {
    const worker = await launch('hold-worker');
    let pid = 0;
    try {
      await vi.waitFor(async () => {
        await getOwnedCodexRuntimeTail(worker.surfaceId);
        const saved = JSON.parse(readFileSync(worker.sessionPath, 'utf8')) as OwnedSessionRecord;
        expect(saved.threadId).toBeTruthy();
        pid = saved.activeRun!.pid;
      }, { timeout: 10_000, interval: 50 });
      expect(await interruptOwnedCodexSession(worker.surfaceId)).toMatchObject({ interrupted: true });
      await vi.waitFor(async () => {
        await getOwnedCodexRuntimeTail(worker.surfaceId);
        const saved = JSON.parse(readFileSync(worker.sessionPath, 'utf8')) as OwnedSessionRecord;
        expect(saved.activeRun).toBeUndefined();
        expect(saved.recentRuns[0].outcome).toBe('interrupted');
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 10_000, interval: 50 });
    } finally {
      await interruptOwnedCodexSession(worker.surfaceId);
    }
  }, 30_000);
});
