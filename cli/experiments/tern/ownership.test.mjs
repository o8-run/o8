/**
 * S3a: real o8 Pi runtime/permission persistence; scripted Pi and fake terminal.
 * No live provider, installed CLI, Tern GUI, OMP, daemon or packet dispatch proof.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDataDir } from '@/lib/data-dir-migration';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn(), notifyApprovalResolved: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const sessions = [];
const viewers = new Set();
let root, piRuntime, approvals, resolveApproval, getOwnedPiTelemetrySources;
async function until(read, label) {
  const end = Date.now() + 10_000;
  let lastError;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; }
    catch (error) { lastError = error; }
    await sleep(25);
  }
  throw Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function rows(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

beforeAll(async () => {
  await mkdir(getDataDir(), { recursive: true });
  root = await realpath(await mkdtemp(join(getDataDir(), 'tern-owner-')));
  vi.stubEnv('O8_OWNED_PI_ROOT', join(root, 'sessions'));
  const wrapper = join(root, 'pi');
  // Worker children get an allowlisted environment (#4585), so the case's fixture root cannot ride
  // the parent's env. The wrapper reads the current case from a file and hands it to the worker.
  await writeFile(wrapper, `#!/bin/sh\nO8_TERN_PI_FIXTURE_ROOT="$(cat ${shellQuote(join(root, 'current-fixture'))})" `
    + `exec ${shellQuote(process.execPath)} ${shellQuote(join(here, 'fixtures/pi-permission-worker.mjs'))} "$@"\n`, { mode: 0o700 });
  vi.stubEnv('O8_PI_BIN', wrapper);
  ({ piRuntime } = await import('@/lib/runtimes/pi'));
  approvals = await import('@/lib/approvals/store');
  ({ resolveApproval } = await import('@/lib/approvals/resolution'));
  ({ getOwnedPiTelemetrySources } = await import('@/lib/pi/owned'));
});

afterAll(async () => {
  for (const child of viewers) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const key of sessions) {
    for (const approval of approvals.listApprovalsForContext({ sessionKey: key })) {
      if (approval.status === 'pending') resolveApproval(approval.id, 'reject', 'test', 'Fixture teardown');
    }
  }
  // Let the real permission bridge observe teardown decisions before stopping children.
  await sleep(350);
  for (const key of sessions) await piRuntime.interrupt(key).catch(() => {});
  await sleep(100);
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(label) {
  const fixtureRoot = await mkdtemp(join(root, 'case-'));
  const workspace = join(fixtureRoot, 'workspace');
  await mkdir(workspace);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  await writeFile(join(root, 'current-fixture'), fixtureRoot);
  const result = await piRuntime.launch({ cwd: workspace, prompt: `ownership ${label}`, packetId: `packet-${label}` });
  expect(result.ok).toBe(true);
  expect(result.sessionKey).toMatch(/^pi-owned:/);
  sessions.push(result.sessionKey);
  const f = { key: result.sessionKey, fixtureRoot, log: join(fixtureRoot, 'worker.jsonl') };
  f.approval = await pending(f.key);
  await until(async () => (await piRuntime.readTranscript(f.key)).some(entry => entry.text.includes('before-permission-1')), 'persisted initial transcript');
  f.pid = (await until(async () => (await rows(f.log)).find(row => row.event === 'boot'), 'real RPC child')).pid;
  return f;
}
async function pending(key) {
  return until(() => approvals.listApprovalsForContext({ sessionKey: key }).find(item => item.status === 'pending'), 'persisted pending approval');
}
async function readRecord(f) {
  const sources = await getOwnedPiTelemetrySources(f.key);
  expect(sources.stdoutPaths.length).toBeGreaterThan(0);
  return JSON.parse(await readFile(join(dirname(dirname(sources.stdoutPaths[0])), 'session.json'), 'utf8'));
}
async function settled(f) {
  // The normal transcript reader saves metadata. Wait for the runtime's own
  // agent_end/get_state writes before invoking it, so the observer test does
  // not introduce an unrelated competing-writer race during settlement.
  await until(async () => {
    const record = await readRecord(f);
    const sources = await getOwnedPiTelemetrySources(f.key);
    const log = await rows(sources.stdoutPaths.at(-1));
    return !record.activeRun && record.piSessionFile
      && log.some(frame => frame.type === 'o8_permission_gate_resolved');
  }, 'settled durable session and permission receipt');
}
async function snapshot(f) {
  const record = await readRecord(f);
  const transcript = (await piRuntime.readTranscript(f.key)).map(({ id, role, text }) => ({ id, role, text }));
  return { record, transcript, wire: await rows(f.log), approval: approvals.getApproval(f.approval.id) };
}
function payload(record) {
  // Lab read adapter is injected, but every displayed session fact comes from o8 storage.
  return { schema: 'o8/cli/packet.info/v1', packet: {
    laneId: record.laneId ?? record.surfaceId, id: record.packetId,
    status: record.activeRun?.outcome ?? 'reviewing', runtime: 'pi', actualRuntime: 'pi',
    branch: record.branch, baseBranch: 'main', repoPath: record.repoPath, worktreePath: record.cwd,
    label: record.title, events: record.recentRuns.map(run => ({ id: run.id,
      timestamp: run.startedAt, actor: 'fixture', verb: run.outcome, payload: {} })),
  } };
}
async function observe(f, mode) {
  const { record } = await snapshot(f);
  const child = fork(join(here, 'fixtures/observer-process.mjs'), [], {
    execArgv: [], cwd: here, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Give the observer the same data root the owner uses, so a regression that wrote o8 state
    // directly would land where unchanged() looks, not in a developer's real data directory.
    env: { PATH: process.env.PATH, NODE_ENV: 'test', O8_DATA_DIR: getDataDir(), O8_OWNED_PI_ROOT: join(root, 'sessions') },
  });
  viewers.add(child);
  const messages = [];
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.resume();
  child.on('message', message => messages.push(message));
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await until(() => {
    if (child.exitCode !== null) throw Error(stderr || `observer exited ${child.exitCode}`);
    return messages.some(message => message.type === 'ready');
  }, 'observer SDK import');
  child.send({ mode, payload: payload(record) });
  if (mode === 'signal') {
    await until(() => messages.some(message => message.type === 'waiting-for-hello'), 'observer negotiation');
    child.kill('SIGTERM');
    expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
  } else {
    const done = await until(() => {
      const failure = messages.find(message => message.type === 'failure');
      if (failure) throw Error(failure.error);
      return messages.find(message => message.type === 'done');
    }, 'observer completion');
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(done.result.renderer).toBe(mode === 'frame-loss' ? 'text' : 'tsp');
    expect(done.reads).toEqual([{ command: 'o8', args: ['packet', 'info', record.packetId, '--json'] }]);
    // Forgeries were aimed at every node of the first frame and the SDK parsed every one.
    // forge.test.mjs carries the positive control that this aim reaches node handlers.
    expect(done.targets.length).toBeGreaterThan(1);
    expect(done.injections).toBe(done.targets.length * 10);  // five acts, each as action and activate
    expect(done.parsedEvents).toBe(done.injections);
    expect(done.raw).toBe(false);
    expect(done.listeners).toBe(0);
  }
  viewers.delete(child);
}
async function unchanged(f, before) {
  expect(alive(f.pid)).toBe(true);
  expect(approvals.getApproval(f.approval.id)).toEqual(before.approval);
  expect((await rows(f.log))).toEqual(before.wire);
  const after = await snapshot(f);
  expect(after.record.activeRun.id).toBe(before.record.activeRun.id);
  expect(after.record.activeRun.outcome).toBe('running');
  expect(after.transcript).toEqual(before.transcript);
  expect((await piRuntime.discoverSessions()).find(session => session.sessionKey === f.key)?.status).toBe('running');
}
async function decide(f, action) {
  expect(resolveApproval(f.approval.id, action, 'test', 'Explicit o8 test decision')).not.toBeNull();
  await until(async () => (await rows(f.log)).find(row => row.event === 'permission'), 'permission response through o8');
  await settled(f);
  expect((await piRuntime.readTranscript(f.key)).some(entry => entry.text.includes(`${action === 'approve' ? 'approved' : 'denied'}-1`))).toBe(true);
}
async function stop(f) {
  expect((await piRuntime.interrupt(f.key)).ok).toBe(true);
  await until(() => !alive(f.pid), 'owned interrupt stops its own process');
  await until(async () => !(await readRecord(f)).rpcPid, 'persisted RPC process retirement');
}

describe('Tern observer cannot own Pi RPC lifecycle or permissions', () => {
  it.each(['native', 'frame-loss', 'signal'])('%s viewer exit leaves the worker and approval intact', async mode => {
    const f = await start(mode);
    const before = await snapshot(f);
    expect(before.approval.status).toBe('pending');
    await observe(f, mode);
    await unchanged(f, before);
    if (mode === 'signal') {
      await observe(f, 'native');
      await unchanged(f, before);
    }
    await decide(f, 'reject');
    expect((await rows(f.log)).filter(row => row.event === 'permission').map(row => row.approved)).toEqual([false]);
    expect(alive(f.pid)).toBe(true); // Permission denial is not process termination.
    await stop(f);
  }, 30_000);

  it('reopens a viewer after an owned worker restart without duplicating transcript identities', async () => {
    const f = await start('restart');
    await observe(f, 'native');
    await decide(f, 'reject');
    const before = await snapshot(f);
    const oldPid = f.pid;
    await stop(f);
    await writeFile(join(root, 'current-fixture'), f.fixtureRoot);
    expect((await piRuntime.resume(f.key, 'second owning-runtime turn')).ok).toBe(true);
    f.approval = await pending(f.key);
    f.pid = (await until(async () => (await rows(f.log)).find(row => row.event === 'boot' && row.pid !== oldPid), 'new RPC process')).pid;
    await until(async () => (await piRuntime.readTranscript(f.key)).some(entry => entry.text.includes('before-permission-2')), 'resumed transcript');
    const resumed = await snapshot(f);
    const boot = resumed.wire.find(row => row.event === 'boot' && row.pid === f.pid);
    expect(boot.argv).toContain('--session');
    expect(boot.turn).toBe(1);
    for (const entry of before.transcript) expect(resumed.transcript.filter(item => item.id === entry.id)).toEqual([entry]);
    await observe(f, 'native');
    await unchanged(f, resumed);
    expect(resolveApproval(f.approval.id, 'approve', 'test', 'Explicit second-turn decision')).not.toBeNull();
    await until(async () => (await rows(f.log)).filter(row => row.event === 'permission').length === 2, 'second correlated permission');
    await settled(f);
    expect((await piRuntime.readTranscript(f.key)).some(entry => entry.text.includes('approved-2'))).toBe(true);
    expect((await rows(f.log)).filter(row => row.event === 'permission').map(row => row.approved)).toEqual([false, true]);
    await stop(f);
  }, 30_000);
});
