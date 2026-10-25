import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync, realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-hermes-worker-real-'));
const userHome = path.join(root, 'user-home');
const workspace = path.join(userHome, 'repo');
const sessionsRoot = path.join(root, 'sessions');
const pidLog = path.join(root, 'pids.log');
const permissionLog = path.join(root, 'permissions.log');
const launchLog = path.join(root, 'launches.log');
const modelLog = path.join(root, 'models.log');
const executedModelLog = path.join(root, 'executed-models.log');
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'hermes-acp-runtime.mjs');
const wrapper = path.join(root, 'hermes');
const previousHome = process.env.HOME;

async function waitForAssistant(
  read: () => Promise<Array<{ role: string; text: string }>>,
  count: number,
  settled: () => Promise<boolean>,
): Promise<Array<{ role: string; text: string }>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const transcript = await read();
    const answers = transcript.filter((entry) => entry.role === 'assistant');
    if (answers.length >= count && answers.at(-1)?.text === `hermes fixture response ${count}` && await settled()) return transcript;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Hermes assistant messages.`);
}

beforeAll(() => {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(userHome, '.hermes'), { recursive: true });
  writeFileSync(path.join(userHome, '.hermes', 'config.yaml'), 'model: fixture\n', 'utf8');
  writeFileSync(path.join(userHome, '.hermes', '.env'), 'FIXTURE_TOKEN=1\n', 'utf8');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);

  process.env.HOME = userHome;
  process.env.O8_DATA_DIR = path.join(root, 'data');
  process.env.O8_OWNED_HERMES_ROOT = sessionsRoot;
  process.env.O8_HERMES_BIN = wrapper;
  process.env.O8_HERMES_PID_LOG = pidLog;
  process.env.O8_HERMES_PERMISSION_LOG = permissionLog;
  process.env.O8_HERMES_LAUNCH_LOG = launchLog;
  process.env.O8_HERMES_MODEL_LOG = modelLog;
  process.env.O8_HERMES_EXECUTED_MODEL_LOG = executedModelLog;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  delete process.env.O8_DATA_DIR;
  delete process.env.O8_OWNED_HERMES_ROOT;
  delete process.env.O8_HERMES_BIN;
  delete process.env.O8_HERMES_PID_LOG;
  delete process.env.O8_HERMES_PERMISSION_LOG;
  delete process.env.O8_HERMES_LAUNCH_LOG;
  delete process.env.O8_HERMES_MODEL_LOG;
  delete process.env.O8_HERMES_EXECUTED_MODEL_LOG;
  rmSync(root, { recursive: true, force: true });
});

describe('Hermes worker production runtime seam', () => {
  it('isolates Hermes state, preserves HOME, runs in the packet cwd, resumes on ACP, and normalizes output', async () => {
    const { hermesRuntime } = await import('@/lib/runtimes/hermes');

    const launched = await hermesRuntime.launch({
      cwd: workspace,
      prompt: 'first turn',
      clientMutationId: 'hermes-real-path-1',
      packetId: 'packet-fixture',
      laneId: 'lane-fixture',
      model: 'fixture/model',
    });
    expect(launched).toMatchObject({ ok: true });
    expect(launched.sessionKey).toMatch(/^hermes-owned:/);
    const sessionKey = launched.sessionKey!;
    const waitForTurn = (count: number) => waitForAssistant(
      () => hermesRuntime.readTranscript(sessionKey), count,
      async () => (await hermesRuntime.discoverSessions()).some((session) => session.sessionKey === sessionKey && session.lifecycle?.lastOutcome === 'finished'),
    );

    await waitForTurn(1);
    await expect(hermesRuntime.resume(sessionKey, 'second turn')).resolves.toMatchObject({ ok: true });
    const transcript = await waitForTurn(2);

    expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual([
      'first turn',
      'second turn',
    ]);
    expect(transcript.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
      'hermes fixture response 1',
      'hermes fixture response 2',
    ]);

    const firstPids = readFileSync(pidLog, 'utf8').trim().split('\n');
    expect(firstPids).toHaveLength(2);
    expect(new Set(firstPids).size).toBe(1);
    expect(readFileSync(permissionLog, 'utf8').trim().split('\n')).toEqual([
      'allow-once',
      'allow-once',
    ]);

    const firstLaunch = JSON.parse(readFileSync(launchLog, 'utf8').trim().split('\n')[0]) as {
      cwd: string;
      home: string;
      hermesHome: string;
      argv: string[];
    };
    expect(realpathSync(firstLaunch.cwd)).toBe(realpathSync(workspace));
    expect(firstLaunch.argv).toEqual(['acp', '--accept-hooks']);
    expect(firstLaunch.home).toBe(userHome);
    expect(firstLaunch.hermesHome.startsWith(sessionsRoot)).toBe(true);
    expect(existsSync(path.join(firstLaunch.hermesHome, 'config.yaml'))).toBe(true);
    expect(existsSync(path.join(firstLaunch.hermesHome, '.env'))).toBe(true);
    expect(readFileSync(modelLog, 'utf8').trim().split('\n')).toEqual(['fixture/model']);
    expect(readFileSync(executedModelLog, 'utf8').trim().split('\n')).toEqual([
      'fixture/model', 'fixture/model',
    ]);

    await expect(hermesRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
    await expect(hermesRuntime.resume(sessionKey, 'third turn')).resolves.toMatchObject({ ok: true });
    const resumedTranscript = await waitForTurn(3);
    expect(resumedTranscript.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
      'hermes fixture response 1', 'hermes fixture response 2', 'hermes fixture response 3',
    ]);
    expect(resumedTranscript.some((entry) => entry.text.includes('Replayed history'))).toBe(false);
    expect(readFileSync(executedModelLog, 'utf8').trim().split('\n')).toEqual([
      'fixture/model', 'fixture/model', 'fixture/model',
    ]);

    const pids = readFileSync(pidLog, 'utf8').trim().split('\n');
    expect(pids).toHaveLength(3);
    expect(pids[0]).toBe(pids[1]);
    expect(pids[2]).not.toBe(pids[0]);
    expect(readFileSync(modelLog, 'utf8').trim().split('\n')).toEqual([
      'fixture/model',
      'fixture/model',
    ]);

    await expect(hermesRuntime.discoverSessions()).resolves.toEqual([
      expect.objectContaining({ sessionKey, runtimeId: 'hermes', ownership: 'owned' }),
    ]);
    await expect(hermesRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
  });

  it.each(['before resume', 'after snapshot'] as const)('rebuilds packet context and starts a fresh ACP thread when forgotten %s', async timing => {
    const { hermesRuntime } = await import('@/lib/runtimes/hermes');
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const packetId = 'hermes-forgotten-packet';
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), packets: [{
      id: packetId, branchTarget: 'fixture-forget', title: 'Current retained packet authority', summary: 'Inspect the fixture.',
      workspaceTargetPath: workspace, referenceLabel: packetId, runtime: 'hermes',
      status: 'running', queueState: 'held', releaseState: 'pending', dependencyPacketIds: [], dependencyLabels: [],
    }] });
    const launched = await hermesRuntime.launch({ cwd: workspace, prompt: 'forgotten ACP context canary',
      packetId, model: 'fixture/model' });
    expect(launched.ok, launched.note).toBe(true);
    const key = launched.sessionKey!;
    try {
      await waitForAssistant(() => hermesRuntime.readTranscript(key), 1, async () =>
        (await hermesRuntime.discoverSessions()).some(session => session.sessionKey === key && session.lifecycle?.lastOutcome === 'finished'));
      const { getSqlite } = await import('@/lib/db');
      const { advanceMemoryRevision } = await import('@/lib/cortex/memory-revision');
      if (timing === 'before resume') getSqlite().transaction(() => advanceMemoryRevision(getSqlite()))();
      else {
        const memory = await import('@/lib/dispatch/worker-memory-context');
        const needsRefresh = memory.workerMemoryNeedsRefresh;
        vi.spyOn(memory, 'workerMemoryNeedsRefresh').mockImplementationOnce(session => {
          const prior = needsRefresh(session);
          getSqlite().transaction(() => advanceMemoryRevision(getSqlite()))();
          return prior;
        });
      }
      const resumed = await hermesRuntime.resume(key, 'Keep this fresh operator request');
      expect(resumed, resumed.note).toMatchObject({ ok: true });
      await vi.waitFor(async () => {
        const entries = await hermesRuntime.readTranscript(key);
        expect(entries.filter(entry => entry.role === 'assistant')).toHaveLength(2);
        expect(entries.filter(entry => entry.role === 'assistant').at(-1)?.text).toBe('hermes fixture response 1');
        const prompt = entries.filter(entry => entry.role === 'user').at(-1)?.text;
        expect(prompt).toContain('Current retained packet authority');
        expect(prompt).toContain('Keep this fresh operator request');
        expect(prompt).not.toContain('forgotten ACP context canary');
      }, { timeout: 10_000 });
    } finally { vi.restoreAllMocks(); await hermesRuntime.interrupt(key); }
  });

  it.each([
    ['fixture/unavailable', 'model unavailable'],
    ['fixture/unconfirmed', 'did not confirm a session'],
  ])('does not submit a prompt when model %s is not confirmed', async (model, reason) => {
    const { hermesRuntime } = await import('@/lib/runtimes/hermes');
    const previousPrompts = existsSync(pidLog) ? readFileSync(pidLog, 'utf8') : '';
    const result = await hermesRuntime.launch({
      cwd: workspace, prompt: 'must not execute', model,
    });
    expect(result).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(result.note).toContain(reason);
    expect(existsSync(pidLog) ? readFileSync(pidLog, 'utf8') : '').toBe(previousPrompts);
  });
});
