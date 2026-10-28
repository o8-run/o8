/**
 * #1524 — cold resume: an ARCHIVED owned session with a persisted threadId
 * must be resumable, not "session was not found".
 *
 * The incident: steer_packet (escalation layer 3) 409'd steer_unavailable
 * after a long pause / silent exit had archived the session dir — dead in
 * exactly the scenarios that produce escalations. The runtime's own rollout
 * lives outside our tree, so the thread is fully resumable: resume restores
 * the archived dir and resumes the saved thread, marked cold in the note.
 */
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import type { OwnedRuntimeAdapter, ParsedRunLog } from './types';

const spawnMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

// A pid above macOS/Linux pid_max — isPidAlive is guaranteed false, so the
// launched run reads as exited and resume is allowed.
const DEAD_PID = 9_999_999;

function coldAdapter(): OwnedRuntimeAdapter {
  return {
    runtimeId: 'test-runtime',
    surfaceIdPrefix: 'test-owned:',
    rootEnvVar: 'O8_TEST_OWNED_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-owned-cold'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_BIN',
    humanLabel: 'Owned Test',
    squadShortName: 'Test',
    launchArgs: ({ prompt }) => ['-e', `console.log(${JSON.stringify(prompt)})`],
    resumeArgs: ({ threadId, prompt }) => ['resume', threadId, '-e', `console.log(${JSON.stringify(prompt)})`],
    parseRunLog: (): ParsedRunLog => ({
      entries: [],
      outcome: 'finished',
      completedTurn: true,
      threadId: 'thread-cold-1',
    }),
  };
}

describe('owned-session store cold resume (#1524)', () => {
  let tempRoot: string;
  let repoPath: string;
  let sessionsRoot: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;

  // Load the shared runtime graph outside individual scenario timeouts.
  beforeAll(async () => { await import('./store'); }, 60_000);

  beforeEach(() => {
    // validateWorkspace (helpers.ts) fail-closes owned-runtime launches to
    // paths under the home dir or the configured data dir -- a real security
    // boundary, not something to weaken. A repo checkout is normally under
    // $HOME so a process.cwd()-based temp dir passed that check incidentally,
    // but that stops holding the moment the checkout (or a worktree of it)
    // lives somewhere else. Anchor to getDataDir() instead, which is one of
    // validateWorkspace's allowed roots regardless of where the repo sits on
    // disk, and which the per-worker vitest setup already pins to an isolated
    // scratch dir (tests/setup-isolated-data-dir.ts).
    tempRoot = mkdtempSync(path.join(getDataDir(), '.tmp-owned-cold-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    sessionsRoot = path.join(tempRoot, 'sessions');
    priorRoot = process.env.O8_TEST_OWNED_ROOT;
    priorBin = process.env.O8_TEST_BIN;
    process.env.O8_TEST_OWNED_ROOT = sessionsRoot;
    process.env.O8_TEST_BIN = process.execPath;
    spawnMock.mockReturnValue({ pid: DEAD_PID, unref: vi.fn(), once: vi.fn() });
    ensureDispatchBackendReadyMock.mockResolvedValue({
      ready: true,
      reason: 'http_200',
      waitedMs: 0,
      attempts: 1,
      lastCheck: {
        ready: true,
        reason: 'http_200',
        apiBase: 'http://o8.test',
        status: 200,
        portSource: 'file',
        apiPortFilePresent: true,
      },
    });
  });

  afterEach(() => {
    spawnMock.mockReset();
    ensureDispatchBackendReadyMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_OWNED_ROOT;
    else process.env.O8_TEST_OWNED_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_BIN;
    else process.env.O8_TEST_BIN = priorBin;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resumes an archived session with a persisted threadId, restoring it and marking the resume cold', { timeout: 20_000 }, async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(coldAdapter());

    const launched = await store.launch({ cwd: repoPath, prompt: 'initial work' });
    expect(launched.ok).toBe(true);
    const surfaceId = launched.surfaceId!;

    // A refresh read discovers + persists the threadId from the run log
    // (exactly how real sessions learn theirs before dying).
    await store.getRuntimeTail(surfaceId);

    // The incident state: the run exited and cleanup archived the session dir.
    const archived = await store.archiveSession(surfaceId);
    expect(archived.archived).toBe(true);
    const activeDirs = existsSync(sessionsRoot)
      ? execFileSync('ls', [sessionsRoot]).toString().trim()
      : '';
    expect(activeDirs).toBe('');

    // Old behavior: throws "Owned Test session was not found."
    const resumed = await store.resume(surfaceId, 'one-line follow-up fix');
    expect(resumed.ok).toBe(true);
    expect(resumed.note).toContain('Cold resume');

    // The dir is back in the active tree and the runtime was invoked with the
    // persisted thread id.
    expect(execFileSync('ls', [sessionsRoot]).toString().trim()).not.toBe('');
    const resumeCall = spawnMock.mock.calls.at(-1);
    expect(resumeCall?.[1]).toContain('thread-cold-1');
  });

  it('still reports not-found when nothing exists in the archive either', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(coldAdapter());
    await expect(store.resume('test-owned:ghost-session', 'hello')).rejects.toThrow(/was not found/);
  });

  it('continues in the same saved session with task context when its adapter cannot resume threads', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const adapter = coldAdapter();
    adapter.resumeArgs = () => null;
    const store = createOwnedSessionStore(adapter);
    const launched = await store.launch({ cwd: repoPath, prompt: 'preserved original task' });
    await store.getRuntimeTail(launched.surfaceId);
    const resumed = await store.resume(launched.surfaceId, 'continue after interruption');
    expect(resumed.ok).toBe(true);
    expect(resumed.note).toContain('fresh run in the same checkout');
    const args = spawnMock.mock.calls.at(-1)![1].join(' ');
    expect(args).toContain('preserved original task');
    expect(args).toContain('continue after interruption');
    expect(args).not.toContain('thread-cold-1');
  });

  it('holds new launch and resume at the artifact budget while preserving exact archived recovery', { timeout: 30_000 }, async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(coldAdapter());
    const launched = await store.launch({ cwd: repoPath, prompt: 'retained work' });
    expect(launched.ok).toBe(true);
    await store.getReviewPacket(launched.surfaceId);
    const archived = await store.archiveSession(launched.surfaceId);
    expect(archived.archived).toBe(true);
    const original = readFileSync(path.join(archived.archivePath!, 'session.json'));
    const binding = await store.getWorkspaceBinding!(launched.surfaceId);
    expect(binding?.retainedRunsComplete).toBe(true);
    expect(binding?.activeRun).toBeNull();
    expect(binding?.retainedRuns.map(run => run.outcome)).toEqual(['finished']);
    const retained = path.join(archived.archivePath!, 'required-evidence.bin');
    const fd = openSync(retained, 'wx', 0o600);
    ftruncateSync(fd, 4 * 1024 ** 3);
    closeSync(fd);
    const identity = statSync(retained);
    const calls = spawnMock.mock.calls.length;
    const entries = readdirSync(archived.archivePath!).sort();

    const refused = await store.launch({ cwd: repoPath, prompt: 'must not write' });
    expect(refused).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(refused.note).toContain('artifact');
    const identityHome = path.join(tempRoot, 'identity-home');
    // Policy may look up this path, but refusal must leave it unprepared.
    expect(existsSync(identityHome)).toBe(false);
    const missingCliStore = createOwnedSessionStore({
      ...coldAdapter(), binaryName: 'missing-owned-fixture', isolatedConfigHomeEnv: 'O8_TEST_ISOLATED_HOME',
      defaultConfigHome: () => identityHome,
    });
    expect(await missingCliStore.launch({ cwd: repoPath, prompt: 'must not stage CLI output', packetId: 'budget-held-packet' }))
      .toMatchObject({ ok: false, sideEffect: 'none' });
    expect(existsSync(identityHome)).toBe(false);
    expect(readdirSync(sessionsRoot)).toEqual([]);
    expect(await store.resume(launched.surfaceId, 'must not resume')).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(existsSync(identityHome)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(calls);
    expect(readdirSync(archived.archivePath!).sort()).toEqual(entries);
    // Cold-resume refusal must not change the original archived metadata.
    expect(readFileSync(path.join(archived.archivePath!, 'session.json'))).toEqual(original);
    expect(statSync(retained)).toMatchObject({ dev: identity.dev, ino: identity.ino, size: identity.size });

    const publish = vi.fn();
    await expect(store.recoverArchivedWorkspace!(launched.surfaceId, binding!, publish)).resolves.toMatchObject({ sessionState: 'active' });
    expect(publish).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledTimes(calls);
    expect(await store.sessionState(launched.surfaceId)).toBe('active');
    expect((await store.archiveSession(launched.surfaceId)).archived).toBe(true);
    expect(statSync(retained)).toMatchObject({ dev: identity.dev, ino: identity.ino, size: identity.size });
    expect(existsSync(identityHome)).toBe(false);
  });

  it('refuses a redirected artifact root without following or writing its target', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, sessionsRoot, 'dir');
    const store = createOwnedSessionStore(coldAdapter());
    expect(await store.launch({ cwd: repoPath, prompt: 'unsafe root' })).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a competing process before it can enter the runtime artifact namespace', { timeout: 30_000 }, async () => {
    const { withOwnedArtifactRootLock } = await import('./artifact-admission');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/runtimes/shared/owned-session/artifact-admission.ts')).href;
    const script = `const imported = await import(${JSON.stringify(moduleUrl)});
      const api = imported.default ?? imported;
      try { await api.withOwnedArtifactRootLock(process.env.O8_TEST_OWNED_ROOT, async () => console.log('ENTERED')); }
      catch (error) { if (error.code !== 'owned_artifact_admission_held') throw error; console.log('HELD'); }`;
    await withOwnedArtifactRootLock(sessionsRoot, async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, timeout: 20_000,
      });
      expect(stdout.trim()).toBe('HELD');
    });
    expect(existsSync(sessionsRoot)).toBe(false);
    expect(existsSync(`${sessionsRoot}-archive`)).toBe(false);
  });
});
