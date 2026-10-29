import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRunningSharedCheckoutSurfaceIds } from '@/lib/orchestrator/shared-checkout-team';
import type { OwnedRuntimeAdapter, ParsedRunLog } from './types';

/**
 * A worker a chat launches into its shared checkout has no lane. The owned-session
 * orphan sweeps used to classify its live run as orphaned once it was older than
 * the grace window and interrupt it mid-task (10-27: a chat worker launched at
 * 20:39:52 was interrupted at 20:50:24 with "No lane referenced this owned codex
 * session within 600s of launch").
 *
 * Real path: a real shared-checkout team receipt in the data directory, the real
 * owned-session store (including its own background sweep on creation), and a
 * genuinely live child process with a stale start time.
 */
describe('owned-session orphan sweep — chat-owned shared-checkout workers', () => {
  let tempRoot: string;
  let sessionsRoot: string;
  let teamFile: string;
  let priorRoot: string | undefined;
  const children: Array<ReturnType<typeof spawn>> = [];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-orphan-chat-owned-'));
    sessionsRoot = path.join(tempRoot, 'sessions');
    mkdirSync(sessionsRoot, { recursive: true });
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    process.env.O8_TEST_OWNED_ROOT = sessionsRoot;
    teamFile = path.join(getDataDir(), 'shared-checkout-teams', `chat-owned-${path.basename(tempRoot)}.json`);
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    rmSync(teamFile, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function testAdapter(): OwnedRuntimeAdapter {
    return {
      runtimeId: 'test-runtime',
      surfaceIdPrefix: 'test-owned:',
      rootEnvVar: 'O8_TEST_OWNED_ROOT',
      rootDefault: path.join(os.tmpdir(), 'o8-test-owned-chat-owned'),
      binaryName: 'node',
      binaryEnvOverride: 'O8_TEST_BIN',
      humanLabel: 'Owned Test',
      squadShortName: 'Test',
      launchArgs: () => [],
      resumeArgs: () => [],
      parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'running', completedTurn: false }),
    };
  }

  function seedLiveSession(name: string): { surfaceId: string; sessionDir: string } {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true });
    children.push(child);
    const surfaceId = `test-owned:${name}`;
    const sessionDir = path.join(sessionsRoot, name);
    mkdirSync(path.join(sessionDir, 'runs'), { recursive: true });
    const startedIso = new Date(Date.now() - 11 * 60_000).toISOString();
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      runtimeId: 'test-runtime',
      repoPath: tempRoot,
      createdAt: startedIso,
      updatedAt: startedIso,
      recentRuns: [],
      activeRun: {
        id: `run-${name}`,
        startedAt: startedIso,
        pid: child.pid,
        stdoutPath: path.join(sessionDir, 'runs', 'r.out'),
        stderrPath: path.join(sessionDir, 'runs', 'r.err'),
      },
    }));
    writeFileSync(path.join(sessionDir, 'runs', 'r.out'), '');
    writeFileSync(path.join(sessionDir, 'runs', 'r.err'), '');
    return { surfaceId, sessionDir };
  }

  it('keeps the live run of a chat team member and still sweeps a true orphan', async () => {
    const member = seedLiveSession('chat-team-member');
    const orphan = seedLiveSession('true-orphan');
    mkdirSync(path.dirname(teamFile), { recursive: true });
    writeFileSync(teamFile, JSON.stringify({
      id: 'chat-owned-team',
      path: tempRoot,
      branch: 'fix/example',
      baseHead: 'abc123',
      parentThreadId: 'thoughts-1',
      createdAt: new Date().toISOString(),
      initialChangedPaths: [],
      initialChangedFingerprints: {},
      members: [{
        surfaceId: member.surfaceId,
        runtime: 'test-runtime',
        taskName: 'Fix the chat',
        clientMutationId: 'mutation-1',
        launchedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        paths: ['src'],
        state: 'running',
      }],
    }));

    expect(listRunningSharedCheckoutSurfaceIds().has(member.surfaceId)).toBe(true);
    expect(listRunningSharedCheckoutSurfaceIds().has(orphan.surfaceId)).toBe(false);

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter());
    await store.sweepOrphanedSessions(new Set<string>(), 120_000, listRunningSharedCheckoutSurfaceIds());

    // The chat's worker keeps running in place: not archived, not marked orphaned.
    expect(existsSync(path.join(member.sessionDir, 'session.json'))).toBe(true);
    const kept = JSON.parse(readFileSync(path.join(member.sessionDir, 'session.json'), 'utf8')) as { orphanedAt?: string; activeRun?: unknown };
    expect(kept.orphanedAt).toBeUndefined();
    expect(kept.activeRun).toBeTruthy();

    // A live run nobody owns is still swept, so the sweep itself ran.
    expect(existsSync(path.join(`${sessionsRoot}-archive`, 'true-orphan'))).toBe(true);
  });
});
