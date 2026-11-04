import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-deepseek-harness-real-'));
const pidLog = path.join(root, 'pids.log');
const permissionLog = path.join(root, 'permissions.log');
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'deepseek-harness-jsonrpc-runtime.mjs');

async function waitForAssistant(
  read: () => Promise<Array<{ role: string; text: string }>>,
  count: number,
): Promise<Array<{ role: string; text: string }>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const transcript = await read();
    if (transcript.filter((entry) => entry.role === 'assistant').length >= count) return transcript;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Harness assistant messages.`);
}

async function waitForOutcome(
  read: () => Promise<{ lastRun?: { outcome: string }; summary?: string }>,
  outcome: string,
): Promise<{ lastRun?: { outcome: string }; summary?: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const packet = await read();
    if (packet.lastRun?.outcome === outcome) return packet;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Harness outcome ${outcome}.`);
}

beforeAll(() => {
  process.env.O8_OWNED_DEEPSEEK_HARNESS_ROOT = path.join(root, 'sessions');
  process.env.O8_DEEPSEEK_HARNESS_BIN = process.execPath;
  process.env.O8_DEEPSEEK_HARNESS_ARGS = JSON.stringify([fixture]);
  process.env.O8_DEEPSEEK_HARNESS_PID_LOG = pidLog;
  process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG = permissionLog;
  process.env.DEEPSEEK_API_KEY = 'fixture-key';
  // Worker children inherit only allowlisted names; the fixture reads these test knobs.
  process.env.O8_WORKER_ENV_ALLOW = 'O8_DEEPSEEK_HARNESS_PID_LOG,O8_DEEPSEEK_HARNESS_PERMISSION_LOG';
});

afterAll(() => {
  delete process.env.O8_OWNED_DEEPSEEK_HARNESS_ROOT;
  delete process.env.O8_DEEPSEEK_HARNESS_BIN;
  delete process.env.O8_DEEPSEEK_HARNESS_ARGS;
  delete process.env.O8_DEEPSEEK_HARNESS_PID_LOG;
  delete process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.O8_WORKER_ENV_ALLOW;
  rmSync(root, { recursive: true, force: true });
});

describe('DeepSeek Harness production runtime seam', () => {
  it('launches, records ACP output, resumes on one live process, and interrupts', async () => {
    const { deepSeekHarnessRuntime } = await import('@/lib/runtimes/deepseek-harness');
    const { invalidateDeepSeekHarnessLaunchCache } = await import('@/lib/deepseek-harness/runtime-resolution');
    invalidateDeepSeekHarnessLaunchCache();

    const launched = await deepSeekHarnessRuntime.launch({
      cwd: process.cwd(),
      prompt: 'first turn',
      clientMutationId: 'deepseek-real-path-1',
      packetId: 'packet-fixture',
      laneId: 'lane-fixture',
    });
    expect(launched).toMatchObject({ ok: true });
    expect(launched.sessionKey).toMatch(/^deepseek-harness-owned:/);
    const sessionKey = launched.sessionKey!;

    await waitForAssistant(() => deepSeekHarnessRuntime.readTranscript(sessionKey), 1);
    await expect(deepSeekHarnessRuntime.resume(sessionKey, 'second turn')).resolves.toMatchObject({ ok: true });
    await waitForOutcome(
      async () => {
        const { getOwnedDeepSeekHarnessReviewPacket } = await import('@/lib/deepseek-harness/owned');
        return getOwnedDeepSeekHarnessReviewPacket(sessionKey);
      },
      'finished',
    );
    const transcript = await waitForAssistant(() => deepSeekHarnessRuntime.readTranscript(sessionKey), 2);
    expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual([
      'first turn',
      'second turn',
    ]);
    expect(transcript.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
      'fixture response 1',
      'fixture response 2',
    ]);

    const pids = readFileSync(pidLog, 'utf8').trim().split('\n');
    expect(pids).toHaveLength(2);
    expect(new Set(pids).size).toBe(1);
    expect(readFileSync(permissionLog, 'utf8').trim().split('\n')).toEqual([
      'allow-once',
      'allow-once',
    ]);
    const { lookupOwnedActiveRunFresh } = await import('@/lib/runtimes/shared/owned-session-index');
    await expect(lookupOwnedActiveRunFresh(sessionKey)).resolves.toMatchObject({
      pid: Number(pids[0]),
      commandIdentity: path.basename(process.execPath),
    });
    await expect(deepSeekHarnessRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
    const { getOwnedDeepSeekHarnessReviewPacket } = await import('@/lib/deepseek-harness/owned');
    await expect(getOwnedDeepSeekHarnessReviewPacket(sessionKey)).resolves.toMatchObject({
      lastRun: { outcome: 'finished' },
    });
    await expect(deepSeekHarnessRuntime.resume(sessionKey, 'third turn')).resolves.toMatchObject({
      ok: false,
      sideEffect: 'none',
    });
    await expect(deepSeekHarnessRuntime.discoverSessions()).resolves.toEqual([
      expect.objectContaining({ sessionKey, runtimeId: 'deepseek-harness', ownership: 'owned' }),
    ]);
  });

  it('settles a malformed ACP prompt receipt as failed instead of leaving a live turn', async () => {
    const { deepSeekHarnessRuntime } = await import('@/lib/runtimes/deepseek-harness');
    const launched = await deepSeekHarnessRuntime.launch({
      cwd: process.cwd(),
      prompt: 'malformed response',
      clientMutationId: 'deepseek-real-path-malformed',
    });
    expect(launched).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    const { getOwnedDeepSeekHarnessReviewPacket } = await import('@/lib/deepseek-harness/owned');
    const packet = await waitForOutcome(
      () => getOwnedDeepSeekHarnessReviewPacket(sessionKey),
      'failed',
    );
    expect(packet.summary).toContain('returned no stopReason');
    await expect(deepSeekHarnessRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
  });
});
