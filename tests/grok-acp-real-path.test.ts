import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-grok-acp-real-'));
const pidLog = path.join(root, 'pids.log');
const lifecycleLog = path.join(root, 'lifecycle.log');
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'grok-acp-runtime.mjs');

async function waitForAssistant(
  read: () => Promise<Array<{ role: string; text: string }>>,
  count: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const transcript = await read();
    if (transcript.filter((entry) => entry.role === 'assistant').length >= count) return transcript;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Grok assistant messages.`);
}

beforeAll(async () => {
  process.env.O8_OWNED_GROK_ROOT = path.join(root, 'sessions');
  process.env.O8_GROK_BIN = fixture;
  process.env.O8_GROK_FIXTURE_PID_LOG = pidLog;
  process.env.O8_GROK_FIXTURE_LIFECYCLE_LOG = lifecycleLog;
  // Worker children inherit only allowlisted names; the fixture reads these test knobs.
  process.env.O8_WORKER_ENV_ALLOW = 'O8_GROK_FIXTURE_PID_LOG,O8_GROK_FIXTURE_LIFECYCLE_LOG';
  const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
  invalidateCliCache('grok');
});

afterAll(async () => {
  delete process.env.O8_OWNED_GROK_ROOT;
  delete process.env.O8_GROK_BIN;
  delete process.env.O8_GROK_FIXTURE_PID_LOG;
  delete process.env.O8_GROK_FIXTURE_LIFECYCLE_LOG;
  delete process.env.O8_WORKER_ENV_ALLOW;
  const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
  invalidateCliCache('grok');
  rmSync(root, { recursive: true, force: true });
});

describe('Grok official ACP production runtime seam', () => {
  it('launches, reconnects the durable session, projects cost, and archives', async () => {
    const { grokRuntime } = await import('@/lib/runtimes/grok');
    const launched = await grokRuntime.launch({
      cwd: process.cwd(),
      prompt: 'first turn',
      clientMutationId: 'grok-acp-real-path',
      model: 'grok-4.6',
      laneId: 'lane-grok-fixture',
      packetId: 'packet-grok-fixture',
    });
    expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    expect(sessionKey).toMatch(/^grok-owned:/);

    await waitForAssistant(() => grokRuntime.readTranscript(sessionKey), 1);
    await expect(grokRuntime.getTelemetry?.(sessionKey)).resolves.toMatchObject({
      inputTokens: 101,
      outputTokens: 11,
      cacheReadTokens: 1,
      estimatedCostUsd: 0.001,
      model: 'grok-4.6',
    });
    await expect(grokRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });

    await expect(grokRuntime.resume(sessionKey, 'second turn')).resolves.toMatchObject({ ok: true });
    const transcript = await waitForAssistant(() => grokRuntime.readTranscript(sessionKey), 2);
    expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual([
      'first turn',
      'second turn',
    ]);
    expect(new Set(readFileSync(pidLog, 'utf8').trim().split('\n')).size).toBe(2);
    expect(readFileSync(lifecycleLog, 'utf8')).toContain('new:');
    expect(readFileSync(lifecycleLog, 'utf8')).toContain('resume:grok-fixture-session');

    await expect(grokRuntime.discoverSessions()).resolves.toEqual([
      expect.objectContaining({
        sessionKey,
        runtimeId: 'grok',
        model: 'grok-4.6',
        ownership: 'owned',
      }),
    ]);
    const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
    const lifecycle = getOwnedSessionLifecycle(sessionKey);
    await expect(lifecycle?.setDetachedSession?.(sessionKey, 'fixture detached close')).resolves.toMatchObject({
      updated: true,
    });
    await expect(grokRuntime.discoverSessions()).resolves.toEqual([]);
    const { archiveOwnedGrokSession, ownedGrokSessionState, sweepOrphanedGrokSessions } = await import('@/lib/grok/owned');
    await expect(sweepOrphanedGrokSessions(new Set(), 0)).resolves.toBe(0);
    await expect(grokRuntime.resume(sessionKey, 'detached turn')).rejects.toThrow('detached from its closed packet');
    await expect(lifecycle?.setDetachedSession?.(sessionKey, null)).resolves.toMatchObject({ updated: true });
    await expect(archiveOwnedGrokSession(sessionKey)).resolves.toMatchObject({ archived: true });
    await expect(ownedGrokSessionState(sessionKey)).resolves.toBe('archived');
  }, 30_000);
});
