import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchBackendWaitResult } from '@/lib/runtimes/shared/dispatch-readiness';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn());
const fetchRuntimeLaunchMock = vi.hoisted(() => vi.fn());
const handleWorkerFailureSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});
vi.mock('@/lib/ws-server/next-fetch', () => ({ fetchRuntimeLaunch: fetchRuntimeLaunchMock }));
vi.mock('./worker-failure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-failure')>();
  return { ...actual, createWorkerFailureHandler: (...args: Parameters<typeof actual.createWorkerFailureHandler>) => {
    const handle = actual.createWorkerFailureHandler(...args);
    return async (...runArgs: Parameters<typeof handle>) => {
      handleWorkerFailureSpy(...runArgs);
      return handle(...runArgs);
    };
  } };
});

describe('createOwnedSessionStore child exit recording', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorRoot: string | undefined;
  let priorBin: string | undefined;
  let priorSandbox: string | undefined;
  let priorCodexRoot: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(getDataDir(), '.tmp-owned-child-exit-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    priorRoot = process.env.O8_TEST_CHILD_EXIT_ROOT;
    priorBin = process.env.O8_TEST_CHILD_EXIT_BIN;
    priorSandbox = process.env.O8_WORKER_SANDBOX;
    priorCodexRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
    process.env.O8_TEST_CHILD_EXIT_ROOT = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_CHILD_EXIT_BIN = process.execPath;
    process.env.O8_TEST_CHILD_EXIT_REPO = repoPath;
    ensureDispatchBackendReadyMock.mockResolvedValue(readyResult());
    fetchRuntimeLaunchMock.mockResolvedValue({ surfaceId: 'codex-owned:unexpected-retry' });
  });

  afterEach(async () => {
    handleWorkerFailureSpy.mockReset();
    ensureDispatchBackendReadyMock.mockReset();
    fetchRuntimeLaunchMock.mockReset();
    if (priorRoot === undefined) delete process.env.O8_TEST_CHILD_EXIT_ROOT;
    else process.env.O8_TEST_CHILD_EXIT_ROOT = priorRoot;
    if (priorBin === undefined) delete process.env.O8_TEST_CHILD_EXIT_BIN;
    else process.env.O8_TEST_CHILD_EXIT_BIN = priorBin;
    if (priorSandbox === undefined) delete process.env.O8_WORKER_SANDBOX;
    else process.env.O8_WORKER_SANDBOX = priorSandbox;
    if (priorCodexRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
    else process.env.CORTEX_IDE_OWNED_CODEX_ROOT = priorCodexRoot;
    delete process.env.O8_TEST_CHILD_EXIT_REPO;
    delete process.env.O8_TEST_SANDBOX_DENIED_PATH;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('records nonzero exit code and stderr tail from the real runner child', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));

    const launched = await store.launch({ cwd: repoPath, prompt: 'exit 1' });
    const session = await waitForRecordedExit(launched.surfaceId);
    const run = session.recentRuns[0];

    expect(run.childExit).toMatchObject({
      code: 1,
      signal: null,
      classification: 'nonzero-exit',
    });
    expect(run.childExit?.stderrTail).toContain('rmcp session-delete 404');
  }, 20_000);

  it.each([
    { kind: 'auth-failure' as const, expected: 'held' as const },
    { kind: 'exit-1' as const, expected: 'launched' as const },
  ])('handles a real Codex child $kind without misclassifying other exits', async ({ kind, expected }) => {
    const [{ appendEvent, attachSession, createLane, getLane, getLaneEvents, setLaneStatus }, { createOwnedSessionStore }, { relaunchSupervisedAgent }, { buildDomainLaneSummaries, writeOrchestratorControlPlaneState }, { createEmptyOrchestratorMissionState, reconcileOrchestratorMissionState }, { acceptedLaunchAttachmentProvenance }, { runSilentExitTriageForLane }] = await Promise.all([
      import('@/lib/lane/registry'), import('./store'),
      import('@/lib/supervisor/relaunch-agent'), import('@/lib/orchestrator/control-plane'),
      import('@/lib/orchestrator/store'), import('@/lib/lane/current-auth-exit'),
      import('@/lib/supervisor/silent-exit-detector'),
    ]);
    execFileSync('git', ['-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'seed'], { cwd: repoPath });
    const worktreePath = path.join(tempRoot, 'packet-worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'agent/auth-failure', worktreePath], { cwd: repoPath });
    const packetId = `pkt-auth-failure-${Date.now()}`;
    const lane = createLane({ repoPath, worktreePath, branch: 'agent/auth-failure',
      runtime: 'codex', packetId });
    setLaneStatus(lane.id, 'launching', 'system', 'launching_session');
    appendEvent(lane.id, 'update', 'system', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: `reservation:${packetId}:1`,
    });
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = process.env.O8_TEST_CHILD_EXIT_ROOT;
    const store = createOwnedSessionStore({ ...testAdapter(kind),
      runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:',
      rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT' }, {
      workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
    });

    const launched = await store.launch({ cwd: worktreePath, prompt: 'Add a note',
      laneId: lane.id, packetId, model: 'gpt-5.6-terra', effort: 'low',
      clientMutationId: `packet-launch:${packetId}:1` });
    expect(launched.ok, launched.note).toBe(true);
    const provenance = acceptedLaunchAttachmentProvenance({
      lane: getLane(lane.id)!, events: getLaneEvents(lane.id, 100),
      surfaceId: launched.surfaceId, clientMutationId: `packet-launch:${packetId}:1`,
    });
    expect(provenance).not.toBeNull();
    attachSession(lane.id, launched.surfaceId, 'system', provenance ?? {});
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    // Recovery now requires a durable active packet; a lane alone is not admission.
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      packets: [{
        id: packetId, referenceLabel: 'auth-check', title: 'auth-check', summary: 'auth-check',
        status: 'running', queueState: 'queued', releaseState: 'pending', runtime: 'codex',
        dependencyPacketIds: [], dependencyLabels: [], blockedReason: null, lane: null, review: null,
        workspaceTargetPath: repoPath, branchTarget: 'agent/auth-failure',
      } satisfies OrchestratorPacket],
    });
    await waitForRecordedExit(launched.surfaceId);
    const supervisor = await import('@/lib/supervisor/agent-supervisor');
    const updates = vi.fn();
    const relaunch = vi.fn(relaunchSupervisedAgent);
    supervisor.startSupervisorLoop({
      fetchFleetStatus: async () => [{ sessionKey: launched.surfaceId, status: 'failed' }],
      fetchTranscript: async () => [], steerAgent: async () => {}, interruptAgent: async () => {},
      relaunchAgent: relaunch, broadcastAgentUpdate: updates, queueOrchestratorEscalation: () => {},
    });
    supervisor.stopSupervisorLoop();
    supervisor.registerWatchedAgent(launched.surfaceId, repoPath, 'auth-check', 'Add a note');
    supervisor.getWatchedAgents(repoPath)[0].nextPollAt = 0;
    await supervisor.runSupervisorTickForTesting();
    expect(relaunch).toHaveBeenCalledTimes(1);
    const result = await relaunch.mock.results[0].value;
    supervisor.stopSupervisorLoop();
    for (const watch of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(watch.surfaceId);

    expect(result.status).toBe(expected);
    expect(fetchRuntimeLaunchMock).toHaveBeenCalledTimes(expected === 'held' ? 0 : 1);
    const summary = buildDomainLaneSummaries(new Set([packetId]));
    if (expected === 'held') {
      if (result.status !== 'held') throw new Error('Expected the auth retry to be held.');
      expect(result.reason).toContain('codex login');
      expect(getLane(lane.id)).toMatchObject({
        status: 'awaiting_input', lastEventLabel: 'codex_auth_recovery_required',
      });
      await runSilentExitTriageForLane(lane.id);
      expect(getLane(lane.id)).toMatchObject({
        status: 'awaiting_input', lastEventLabel: 'codex_auth_recovery_required',
      });
      expect(summary[0]?.failureMessage).toContain('codex login');
      const packet = {
        id: packetId, referenceLabel: 'auth-check', title: 'auth-check', summary: 'auth-check',
        status: 'failed', queueState: 'queued', releaseState: 'pending', runtime: 'codex',
        wave: 1, dependencyPacketIds: [], dependencyLabels: [], blockedReason: 'runtime_process_exit', lane: null, review: null,
        workspaceTargetPath: repoPath, branchTarget: 'agent/auth-failure',
      } as OrchestratorPacket;
      const state = { ...createEmptyOrchestratorMissionState(), packets: [packet] };
      const reconciled = reconcileOrchestratorMissionState(state, {
        laneSnapshots: [], runtimeTruth: [], domainLanes: summary,
      });
      expect(reconciled.packets[0]?.blockedReason).toContain('codex login');
      expect(reconciled.packets[0]?.queueState).toBe('held');
      expect(reconcileOrchestratorMissionState(state, {
        laneSnapshots: [], runtimeTruth: [], domainLanes: summary.map((entry) => ({ ...entry, status: 'failed' })),
      }).packets[0]?.blockedReason).toContain('codex login');
      expect(updates).toHaveBeenCalledWith(expect.objectContaining({ status: 'awaiting_input', detail: result.reason }));
      const customState = { ...state, packets: [{ ...packet, blockedReason: 'Merge conflict in README.md' }] };
      expect(reconcileOrchestratorMissionState(customState, {
        laneSnapshots: [], runtimeTruth: [], domainLanes: summary,
      }).packets[0]?.blockedReason).toBe('Merge conflict in README.md');
      attachSession(lane.id, launched.surfaceId, 'system');
      expect(buildDomainLaneSummaries(new Set([packetId]))[0]?.failureMessage).toBeNull();
      attachSession(lane.id, 'codex-owned:replacement-session', 'system');
      expect(buildDomainLaneSummaries(new Set([packetId]))[0]?.failureMessage).toBeNull();
    } else {
      expect(summary[0]?.failureMessage).toBeNull();
    }
  }, 20_000);

  it('records SIGKILL signal and stderr tail from the real runner child', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('sigkill'));

    const launched = await store.launch({ cwd: repoPath, prompt: 'sigkill' });
    const session = await waitForRecordedExit(launched.surfaceId);
    const run = session.recentRuns[0];

    expect(run.childExit).toMatchObject({
      code: null,
      signal: 'SIGKILL',
      classification: 'signal-kill',
    });
    expect(run.childExit?.stderrTail).toContain('rmcp session-delete 404');
  }, 20_000);

  it('persists provider failure truth when the real child exits zero', async () => {
    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('./store'),
    ]);
    const lane = createLane({
      repoPath,
      branch: 'main',
      runtime: 'claude-code',
      label: 'provider error child exit',
    });
    const store = createOwnedSessionStore(testAdapter('provider-error'));

    const launched = await store.launch({
      cwd: repoPath,
      prompt: 'provider exits zero with an error result',
      laneId: lane.id,
    });
    const session = await waitForRecordedExit(launched.surfaceId);
    const event = await waitForLaneEvent(lane.id, 'runtime_process_exit', getLaneEvents);

    expect(session.recentRuns[0]).toMatchObject({
      outcome: 'failed',
      childExit: { code: 0, classification: 'clean-exit' },
    });
    expect(event.payload).toMatchObject({
      exitCode: 0,
      classification: 'clean-exit',
      runtimeOutcome: 'failed',
      completedTurn: false,
      providerFailure: { subtype: 'success', message: 'Not logged in' },
    });
  }, 20_000);

  it('reconciles a stored successful bridge run through tail and review using provider failure', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const { deriveRunOutcome } = await import('./helpers');
    const adapter = testAdapter('provider-error');
    const store = createOwnedSessionStore(adapter);
    const surfaceId = 'test-child-provider-error:bridge-failure';
    await writeSession(surfaceId, 'bridge-failure');
    const sessionPath = path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'bridge-failure', 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    const run = session.recentRuns[0];
    run.outcome = 'finished';
    run.detachMode = 'bridge';
    run.childExit = { code: 0, signal: null, classification: 'clean-exit' };
    session.updatedAt = new Date().toISOString();
    session.activeRun = undefined;
    await writeFile(run.stdoutPath, '{"is_error":true}\n');
    await writeFile(sessionPath, JSON.stringify(session));
    const parsed = adapter.parseRunLog('{"is_error":true}', run);
    expect(deriveRunOutcome(run, { ...parsed, completedTurn: true }, '', [])).toBe('failed');
    expect(deriveRunOutcome({ ...run, outcome: 'interrupted' }, parsed, '', [])).toBe('interrupted');
    expect(deriveRunOutcome({ ...run, interruptRequestedAt: new Date().toISOString() }, parsed, '', [])).toBe('interrupted');
    expect((await store.getRuntimeTail(surfaceId)).groups[0]?.outcome).toBe('failed');
    expect((await store.getReviewPacket(surfaceId)).lastRun?.outcome).toBe('failed');
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    expect(persisted.recentRuns[0].outcome).toBe('failed');
  });

  it.each([false, true])('refuses a missing terminal result after child exit (warm transcript cache: %s)', async (warmCache) => {
    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }, { claudeCodeOwnedAdapter }] = await Promise.all([
      import('@/lib/lane/registry'), import('./store'), import('@/lib/claude-code/owned'),
    ]);
    const lane = createLane({ repoPath, branch: 'main', runtime: 'claude-code' });
    const stream = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }] } },
      { type: 'message_stop' }, { type: 'system', subtype: 'compact_boundary' },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    const readyPath = path.join(tempRoot, 'stream-ready');
    const releasePath = path.join(tempRoot, 'release-child');
    const script = `
      const fs = require('node:fs');
      process.stdout.write(${JSON.stringify(stream)}, () => {
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        setInterval(() => {
          if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0);
        }, 10);
        setTimeout(() => process.exit(3), 8000);
      });
    `;
    const parseRunLog = vi.fn(claudeCodeOwnedAdapter.parseRunLog);
    const store = createOwnedSessionStore({
      ...testAdapter('provider-error'),
      launchArgs: () => ['-e', script],
      parseRunLog,
    });
    const launched = await store.launch({ cwd: repoPath, prompt: 'synthetic missing result', laneId: lane.id });
    try {
      await vi.waitFor(async () => expect(await readFile(readyPath, 'utf8')).toBe('ready'), { timeout: 3000 });
      if (warmCache) {
        const tail = await store.getRuntimeTail(launched.surfaceId);
        expect(tail.groups[0]?.entries.some((entry) => entry.text === 'partial work')).toBe(true);
        const parseCount = parseRunLog.mock.calls.length;
        await store.getRuntimeTail(launched.surfaceId);
        expect(parseRunLog).toHaveBeenCalledTimes(parseCount);
      }
    } finally {
      await writeFile(releasePath, 'exit without further output');
      await waitForRecordedExit(launched.surfaceId);
    }
    const session = await waitForRecordedExit(launched.surfaceId);
    const event = await waitForLaneEvent(lane.id, 'runtime_process_exit', getLaneEvents);
    expect(session.recentRuns[0]).toMatchObject({ outcome: 'failed', childExit: { code: 0 } });
    expect(event.payload).toMatchObject({
      runtimeOutcome: 'failed', completedTurn: false, providerFailure: { subtype: 'missing_result' },
    });
    expect(parseRunLog.mock.calls.some(([raw, run]) => raw === stream && run.childExit?.code === 0)).toBe(true);
    expect((await store.getRuntimeTail(launched.surfaceId)).groups[0]?.outcome).toBe('failed');
  }, 20_000);

  it.skipIf(process.platform !== 'darwin').each([false, true])(
    'distinguishes wrapper refusal from a real sandbox-exec denial (valid identity: %s)', async (validIdentity) => {
    const deniedPath = path.join(tempRoot, 'outside-packet.txt');
    await writeFile(deniedPath, 'must stay outside the packet\n', 'utf8');
    process.env.O8_WORKER_SANDBOX = '1';
    process.env.O8_TEST_CHILD_EXIT_BIN = '/bin/cat';
    process.env.O8_TEST_SANDBOX_DENIED_PATH = deniedPath;

    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('./store'),
    ]);
    const packetId = `pkt-sandbox-denial-${Date.now()}`;
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'seed',
    ], { cwd: repoPath });
    const worktreeBase = path.join(repoPath, '.cortex-worktrees');
    const worktreePath = path.join(worktreeBase, packetId);
    const branch = `agent/${packetId}`;
    await mkdir(worktreeBase, { recursive: true });
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], { cwd: repoPath });
    const [{ addRepo }, { captureWorktreeMaterializationIdentity }, { withWorktreeMetaTransaction }] = await Promise.all([
      import('@/lib/repos/registry'),
      import('@/lib/worktree/materialization-identity'),
      import('@/lib/worktree/metadata-store'),
    ]);
    await addRepo(repoPath);
    const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(worktreeBase);
    await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(packetId, {
      id: packetId,
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: 'sandbox denial real path',
      branchName: branch,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity,
      materializationParentIdentity,
    }));
    const lane = createLane({
      label: 'sandbox denial real path',
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const store = createOwnedSessionStore({ ...testAdapter('sandbox-denial'),
      // Credential policies infer runtime identity from the real owned-surface convention.
      surfaceIdPrefix: validIdentity ? 'test-child-sandbox-denial-owned:' : 'test-child-sandbox-denial:' });

    const launched = await store.launch({
      cwd: worktreePath,
      prompt: 'attempt denied read',
      laneId: lane.id,
      packetId,
    });
    expect(launched.ok, launched.note).toBe(true);
    const session = await waitForRecordedExit(launched.surfaceId);
    expect(session.recentRuns[0]).toMatchObject({
      outcome: 'failed', sandboxed: true, childExit: { code: 1, classification: 'nonzero-exit' },
    });
    if (!validIdentity) {
      expect(await readFile(session.recentRuns[0].stderrPath, 'utf8')).toContain('credential policy is invalid');
      expect(session.recentRuns[0].childExit?.stderrTail).not.toContain('Operation not permitted');
      expect(session.recentRuns[0].sandboxDenial).toBeUndefined();
      await waitForLaneEvent(lane.id, 'runtime_process_exit', getLaneEvents);
      await vi.waitFor(() => expect(handleWorkerFailureSpy).toHaveBeenCalledTimes(1));
      expect(getLaneEvents(lane.id, 50).filter((event) => event.verb === 'sandbox_denied')).toEqual([]);
      return;
    }
    expect(session.recentRuns[0].childExit?.stderrTail).toContain(`cat: ${deniedPath}: Operation not permitted`);
    const denialEvent = await waitForLaneEvent(lane.id, 'sandbox_denied', getLaneEvents);

    expect(session.recentRuns[0]).toMatchObject({
      sandboxed: true,
      sandboxDenial: { operation: 'file-read', resource: deniedPath },
    });
    expect(session.latestSummary).toContain(`blocked file-read access to ${deniedPath}`);
    expect(denialEvent.payload).toMatchObject({ operation: 'file-read', resource: deniedPath });
    expect(denialEvent.payload.message).toContain(`blocked file-read access to ${deniedPath}`);
    // A sandbox denial must bypass quota/fallback recovery, which could change the launch.
    expect(handleWorkerFailureSpy).not.toHaveBeenCalled();
    expect(fetchRuntimeLaunchMock).not.toHaveBeenCalled();
    expect(session.activeRun).toBeUndefined();
    expect(session.recentRuns).toHaveLength(1);
  }, 20_000);

  it('sweeps an old active owned session when no lane references its surface id', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));
    const surfaceId = 'test-child-exit-1:orphan-active';
    await writeSession(surfaceId, 'orphan-active');

    await expect(store.sweepOrphanedSessions(new Set(), 120_000)).resolves.toBe(1);
    await expect(access(path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'orphan-active'))).rejects.toThrow();
    await expect(access(path.join(`${process.env.O8_TEST_CHILD_EXIT_ROOT!}-archive`, 'orphan-active', 'session.json'))).resolves.toBeUndefined();
  });

  it.each([false, true])('does not persist quoted source as a denial (failed child: %s)', async (failed) => {
    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }] = await Promise.all([
      import('@/lib/lane/registry'), import('./store'),
    ]);
    const surfaceId = 'test-child-exit-1:quoted-source';
    await writeSession(surfaceId, 'quoted-source');
    const sessionPath = path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'quoted-source', 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    const lane = createLane({ repoPath, branch: 'main', runtime: 'claude-code' });
    session.laneId = lane.id;
    session.createdAt = new Date().toISOString();
    session.updatedAt = session.createdAt;
    session.activeRun = undefined;
    session.recentRuns[0].sandboxed = true;
    session.recentRuns[0].childExit = {
      code: failed ? 1 : 0, signal: null, classification: failed ? 'nonzero-exit' : 'clean-exit',
    };
    await writeFile(session.recentRuns[0].stdoutPath, JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', is_error: false,
        content: '(deny file-read* file-write* ' + 'quoted source '.repeat(1200)
          + '\ncat: /example/secret: Operation not permitted',
      }] },
    }) + '\n');
    await writeFile(sessionPath, JSON.stringify(session));
    const store = createOwnedSessionStore(testAdapter('exit-1'));
    await store.getRuntimeTail(surfaceId);
    await store.getReviewPacket(surfaceId);
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    expect(persisted.recentRuns[0].sandboxDenial).toBeUndefined();
    expect(persisted.latestSummary).not.toContain('sandbox blocked');
    expect(getLaneEvents(lane.id, 50).filter((event) => event.verb === 'sandbox_denied')).toEqual([]);
  });

  it.each(['stderr', 'failed-tool'] as const)('persists an actual %s denial once through tail and review', async (source) => {
    const [{ createLane, getLaneEvents }, { createOwnedSessionStore }, { claudeCodeOwnedAdapter }] = await Promise.all([
      import('@/lib/lane/registry'), import('./store'), import('@/lib/claude-code/owned'),
    ]);
    const surfaceId = 'test-child-exit-1:actual-denial';
    await writeSession(surfaceId, 'actual-denial');
    const sessionPath = path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'actual-denial', 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    const lane = createLane({ repoPath, branch: 'main', runtime: 'claude-code' });
    session.laneId = lane.id;
    session.createdAt = new Date().toISOString();
    session.updatedAt = session.createdAt;
    session.activeRun = undefined;
    session.recentRuns[0].sandboxed = true;
    session.recentRuns[0].childExit = { code: 0, signal: null, classification: 'clean-exit' };
    const diagnostic = 'cat: /example/secret: Operation not permitted';
    const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Recovered' });
    await writeFile(session.recentRuns[0].stderrPath, source === 'stderr' ? diagnostic : '');
    await writeFile(session.recentRuns[0].stdoutPath, (source === 'failed-tool' ? JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: diagnostic }] },
    }) + '\n' : '') + success + '\n');
    await writeFile(sessionPath, JSON.stringify(session));
    const store = createOwnedSessionStore({ ...testAdapter('exit-1'), runtimeId: 'claude-code',
      parseRunLog: claudeCodeOwnedAdapter.parseRunLog });
    await store.getRuntimeTail(surfaceId);
    await store.getReviewPacket(surfaceId);
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as OwnedSessionRecord;
    expect(persisted.recentRuns[0]).toMatchObject({ outcome: 'finished',
      sandboxDenial: { operation: 'file-read', resource: '/example/secret' } });
    expect(persisted.latestSummary).not.toContain('worker stopped');
    expect(getLaneEvents(lane.id, 50).filter((event) => event.verb === 'sandbox_denied')).toHaveLength(1);
  });

  it('keeps an old active owned session when a lane references its surface id', async () => {
    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter('exit-1'));
    const surfaceId = 'test-child-exit-1:lane-bound-active';
    await writeSession(surfaceId, 'lane-bound-active');

    await expect(store.sweepOrphanedSessions(new Set([surfaceId]), 120_000)).resolves.toBe(0);
    await expect(access(path.join(process.env.O8_TEST_CHILD_EXIT_ROOT!, 'lane-bound-active', 'session.json'))).resolves.toBeUndefined();
  });
});

function testAdapter(kind: 'exit-1' | 'sigkill' | 'sandbox-denial' | 'provider-error' | 'auth-failure'): OwnedRuntimeAdapter {
  return {
    runtimeId: `test-child-${kind}`,
    surfaceIdPrefix: `test-child-${kind}:`,
    rootEnvVar: 'O8_TEST_CHILD_EXIT_ROOT',
    rootDefault: path.join(os.tmpdir(), 'o8-test-child-exit'),
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_CHILD_EXIT_BIN',
    humanLabel: 'Owned Child Exit Test',
    squadShortName: 'ChildExit',
    launchArgs: () => kind === 'sandbox-denial'
      ? [process.env.O8_TEST_SANDBOX_DENIED_PATH ?? '/missing-denial-path']
      : ['-e', childScript(kind)],
    resumeArgs: () => kind === 'sandbox-denial'
      ? [process.env.O8_TEST_SANDBOX_DENIED_PATH ?? '/missing-denial-path']
      : ['-e', childScript(kind)],
    parseRunLog: (raw): ParsedRunLog => raw.includes('"is_error":true')
      ? {
          entries: [{ id: 'partial', kind: 'message', label: 'assistant', text: 'partial provider response' }],
          outcome: 'failed',
          completedTurn: false,
          providerFailure: { subtype: 'success', message: 'Not logged in' },
        }
      : { entries: [], outcome: 'running', completedTurn: false },
  };
}

function childScript(kind: 'exit-1' | 'sigkill' | 'provider-error' | 'auth-failure') {
  const stderrLine = 'rmcp session-delete 404 from fake child\\n';
  if (kind === 'exit-1') {
    return `process.stderr.write(${JSON.stringify(stderrLine)}); process.exit(1);`;
  }
  if (kind === 'provider-error') {
    const result = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, result: 'Not logged in',
    });
    return `process.stdout.write(${JSON.stringify(`${result}\n`)}); process.exit(0);`;
  }
  if (kind === 'auth-failure') {
    return `process.stderr.write('diagnostic '.repeat(600) + 'Failed to refresh token: 401 refresh_token_reused\\n'); process.exit(1);`;
  }
  return `process.stderr.write(${JSON.stringify(stderrLine)}); process.stderr.write('', () => process.kill(process.pid, 'SIGKILL'));`;
}

async function waitForLaneEvent(
  laneId: string,
  verb: string,
  getLaneEvents: (id: string, limit?: number) => Array<{ verb: string; payload: Record<string, unknown> }>,
) {
  for (let i = 0; i < 400; i += 1) {
    const event = getLaneEvents(laneId, 20).find((candidate) => candidate.verb === verb);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${verb} lane event on ${laneId}`);
}

async function waitForRecordedExit(surfaceId: string): Promise<OwnedSessionRecord> {
  const root = process.env.O8_TEST_CHILD_EXIT_ROOT;
  if (!root) throw new Error('missing O8_TEST_CHILD_EXIT_ROOT');

  for (let i = 0; i < 400; i += 1) {
    const sessionId = surfaceId.split(':')[1];
    const sessionPath = sessionId ? path.join(root, sessionId, 'session.json') : '';
    const raw = sessionPath ? await readFile(sessionPath, 'utf8').catch(() => '') : '';
    if (raw) {
      const parsed = JSON.parse(raw) as OwnedSessionRecord;
      if (parsed.recentRuns[0]?.childExit) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for child exit payload on ${surfaceId}`);
}

async function writeSession(surfaceId: string, dirName: string): Promise<void> {
  const root = process.env.O8_TEST_CHILD_EXIT_ROOT;
  if (!root) throw new Error('missing O8_TEST_CHILD_EXIT_ROOT');
  const sessionDir = path.join(root, dirName);
  const runsDir = path.join(sessionDir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const old = new Date(Date.now() - 180_000).toISOString();
  const run = {
    id: 'old-run',
    mode: 'launch' as const,
    prompt: 'old prompt',
    startedAt: old,
    pid: 2_147_483_647,
    stdoutPath: path.join(runsDir, 'old-run.jsonl'),
    stderrPath: path.join(runsDir, 'old-run.stderr.log'),
    outcome: 'running' as const,
  };
  await writeFile(run.stdoutPath, 'estimated cost $0.23\n', 'utf8');
  await writeFile(run.stderrPath, '', 'utf8');
  const session: OwnedSessionRecord = {
    surfaceId,
    sessionDir,
    cwd: repoPathForTest(),
    repoPath: repoPathForTest(),
    title: 'orphan test',
    createdAt: old,
    updatedAt: old,
    latestPrompt: 'old prompt',
    latestSummary: 'old prompt',
    recentRuns: [run],
    activeRun: run,
  };
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
}

function repoPathForTest(): string {
  return process.env.O8_TEST_CHILD_EXIT_REPO ?? process.cwd();
}

function readyResult(): DispatchBackendWaitResult {
  return {
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
  };
}
