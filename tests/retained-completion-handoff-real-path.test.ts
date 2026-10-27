import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { checkForgetDependentDispatch } from './fixtures/forget-dependent-dispatch';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import type { AgentRuntime } from '@/lib/runtimes/types';
import type { OwnedSessionRecord, OwnedRuntimeAdapter } from '@/lib/runtimes/shared/owned-session';
import type { WorkspacePreservationPayload } from '@/lib/workspace/preservation-store';
import type { CompletionHandoffRecord } from '@/lib/workspace/completion-handoff-store';

// Stub provider/notification side effects, not completion, ownership, Git,
// context capture, retention, terminal cleanup or private persistence.
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => {}),
}));
vi.mock('@/lib/worktree/storage-telemetry', async original => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null }),
}));
const providerStarts = vi.hoisted(() => vi.fn(async (input: import('@/lib/runtimes/types').LaunchOptions) => ({
  ok: true, sessionKey: `fixture:${input.packetId}`, note: 'Provider seam; no inference.',
})));
vi.mock('@/lib/runtimes', async original => {
  const actual = await original<typeof import('@/lib/runtimes')>();
  return { ...actual, getRuntime: (id: import('@/lib/runtimes/types').RuntimeId) => {
    const runtime = actual.getRuntime(id);
    return runtime ? { ...runtime, launch: providerStarts } : undefined;
  } };
});
const publicationRace = vi.hoisted(() => ({ before: null as null | ((request: { operation?: string; identity?: { canonicalPath: string } }) => void) }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
    const options = args[2];
    if (options && typeof options.input === 'string' && options.input.startsWith('{')) publicationRace.before?.(JSON.parse(options.input));
    return actual.spawnSync(...args);
  } };
});
vi.mock('@/lib/runtime/pty-bridge', async (original) => ({
  ...await original<typeof import('@/lib/runtime/pty-bridge')>(),
  spawnBridgeTerminalSession: vi.fn(async () => { throw new Error('No fixture bridge'); }),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => {}) }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}), publishCortexChange: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/orchestrator/cost-persistence', () => ({ persistRuntimeSessionCost: vi.fn(async () => {}) }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/report-claim-check', () => ({ startReportClaimCheck: vi.fn() }));

const restartRoot = process.env.O8_FORGET_DISPATCH_RESTART_ROOT;
const root = restartRoot ?? realpathSync(mkdtempSync(join(tmpdir(), 'o8-retained-completion-handoff-')));
const dataDir = join(root, 'data');
const sessionsRoot = join(root, 'sessions');
mkdirSync(dataDir, { mode: 0o700, recursive: true });
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = join(dataDir, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = sessionsRoot;

const { closeDb } = await import('@/lib/db');
const { getDataDir } = await import('@/lib/data-dir-migration');
const { addRepo } = await import('@/lib/repos/registry');
const { createLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { acquireWorkspaceRetentionHold, getWorkspaceRetentionHold } = await import('@/lib/workspace/retention-holds');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { handleAgentCompletion } = await import('@/lib/supervisor/agent-completion');
const { capturePacketCompletionContext, readPacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
const { readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
const { readCompletionHandoff } = await import('@/lib/workspace/completion-handoff-store');
// Establish the actual owned-session root registry before supplying the
// transcript-only provider fixture. The production liveness probe stays real.
const { registerRuntime } = await import('@/lib/runtimes');
const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
// A cold route import is setup; the restarted dispatch keeps its normal turn deadline.
if (restartRoot) await import('@/app/api/orchestrator/dispatch/route');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
}

type PersistedHandoff = Pick<WorkspacePreservationPayload, 'packetId' | 'laneId' | 'handoff'>;

// Discover the existing private JSON handoff shape without importing a new
// writer/export or assuming a new storage filename. No in-memory context counts.
function privateHandoffs(directory: string, packetId: string): Array<{ path: string; payload: PersistedHandoff }> {
  const found: Array<{ path: string; payload: PersistedHandoff }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...privateHandoffs(candidate, packetId));
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const payload = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<PersistedHandoff>;
      if (payload.packetId === packetId && payload.handoff) {
        found.push({ path: candidate, payload: payload as PersistedHandoff });
      }
    }
  }
  return found;
}

function coldCompletionContext(packetId: string): PacketContext {
  const cold = execFileSync(process.execPath, [
    '--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'),
    '--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e',
    "const module = await import('./src/lib/orchestrator/context-relay.ts'); const { readPacketCompletionContext } = module.default ?? module; process.stdout.write('\\nCOLD_HANDOFF_CONTEXT:' + JSON.stringify(await readPacketCompletionContext(process.argv[1])));",
    packetId,
  ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15_000 });
  return JSON.parse(cold.split('COLD_HANDOFF_CONTEXT:').at(-1)!) as PacketContext;
}

let passed = false;
let failed = false;
afterEach((context) => { publicationRace.before = null; if (context.task.result?.errors?.length) failed = true; });
afterAll(() => {
  closeDb();
  // Keep a failed fixture available for the lead's private red receipt.
  if (!restartRoot && passed && !failed) rmSync(root, { recursive: true, force: true });
});

let fixtureIndex = 0;
async function fixture(retained = true, transcriptOffsetMs = 0) {
  const repoPath = join(dataDir, 'repo-' + ++fixtureIndex);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 regression');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(join(repoPath, 'tracked.txt'), 'Read-only completion evidence.\n');
  git(repoPath, 'add', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');
  const repo = await addRepo(repoPath);
  const packetId = 'pkt-retained-completion-handoff-' + fixtureIndex;
  const worktreeId = 'packet-' + packetId;
  const branch = 'codex/' + packetId;
  const workspacePath = join(resolveWorktreeRootLayout(repo.localPath).primaryBase, worktreeId);
  mkdirSync(dirname(workspacePath), { recursive: true });
  git(repo.localPath, 'worktree', 'add', '-qb', branch, workspacePath, 'main');
  const head = git(workspacePath, 'rev-parse', 'HEAD');
  const tree = git(workspacePath, 'rev-parse', 'HEAD^{tree}');
  const identity = await captureWorktreeMaterializationIdentity(workspacePath);
  const parentIdentity = await captureWorktreeMaterializationIdentity(dirname(workspacePath));
  const sessionKey = 'codex-owned:codex-owned-' + packetId;
  const lane = createLane({ repoPath: repo.localPath, worktreePath: workspacePath,
    branch, baseBranch: 'main', runtime: 'codex', packetId, sessionKey, ownership: 'managed' });
  await withWorktreeMetaTransaction(repo.localPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'codex', sessionKey, baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity: identity, materializationParentIdentity: parentIdentity,
  }));
  const sessionDir = join(sessionsRoot, 'codex-owned-' + packetId);
  mkdirSync(sessionDir, { recursive: true });
  const completedAt = new Date().toISOString();
  const summary = 'Inspected tracked.txt without changing source.';
  const remainingWork = 'Lead acceptance of the read-only finding remains.';
  const processMarker = 'run-retained-completion-1';
  const exited = spawn(process.execPath, ['-e', ''], {
    cwd: workspacePath, detached: true, stdio: 'ignore', timeout: 10_000,
    env: { ...process.env, O8_OWNED_RUN_MARKER: processMarker },
  });
  await new Promise<void>((resolve, reject) => exited.once('error', reject).once('exit', code => code === 0 ? resolve() : reject(new Error(`Fixture process exit ${code}`))));
  const pid = exited.pid ?? 0;
  expect(pid).toBeGreaterThan(0);
  const session: OwnedSessionRecord = {
    surfaceId: sessionKey, packetId, laneId: lane.id, sessionDir, cwd: workspacePath, repoPath: workspacePath,
    branch, head, title: summary, createdAt: completedAt, updatedAt: completedAt,
    latestPrompt: 'Inspect tracked.txt read-only.', latestSummary: summary,
    threadId: '12345678-1234-1234-1234-123456789abc',
    recentRuns: [{ id: 'run-retained-completion-1', mode: 'launch', prompt: 'Inspect tracked.txt read-only.',
      startedAt: completedAt, finishedAt: completedAt, pid, processGroupId: pid, processMarker, outcome: 'finished',
      stdoutPath: join(sessionDir, 'stdout.jsonl'), stderrPath: join(sessionDir, 'stderr.log'),
      childExit: { code: 0, signal: null, classification: 'clean-exit' } }],
    runIdentityLedger: { version: 1, totalRuns: 1, complete: true },
    workspaceBinding: { logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id,
      packetId, cwd: workspacePath, version: 1, verifiedAt: completedAt },
  };
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(session), { mode: 0o600 });
  // Read each directly published fixture session from current persisted evidence.
  resetOwnedSessionIndex();
  const exitEvent = recordLaneEvent(lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
  const evidence = `tracked.txt:1; lane event ${exitEvent.id}; provider session ${sessionKey}`;
  const transcriptText = `${summary}\n<self-review>${JSON.stringify({ passed: true, confidence: 'high',
    summary, issuesFound: [], outcome: summary, evidence: [evidence], residual: remainingWork,
    decision: 'finding_ready', recurrenceProtection: 'none' })}</self-review>`;
  writeFileSync(session.recentRuns[0].stdoutPath, transcriptText);
  const runtime: AgentRuntime = {
    id: 'codex', displayName: 'Completion transcript fixture',
    capabilities: { discover: false, readTranscript: true, launch: false, resume: false,
      interrupt: false, reviewDiffs: false, costTelemetry: false, streaming: false },
    discoverSessions: async () => [],
    readTranscript: async () => [{ id: 'completion-1', role: 'assistant', text: transcriptText, timestamp: new Date(Date.parse(completedAt) + transcriptOffsetMs) }],
    getChangedFiles: async () => [],
    launch: async () => ({ ok: false, note: 'Transcript-only fixture' }),
    resume: async () => ({ ok: false, note: 'Transcript-only fixture' }),
    interrupt: async () => ({ ok: false, note: 'Transcript-only fixture' }),
  };
  // Load canonical registrations before installing the transcript fixture.
  await import('@/lib/runtimes');
  registerRuntime(runtime);
  const packet: OrchestratorPacket = {
    id: packetId, referenceLabel: '#3260', title: summary, summary, runtime: 'codex',
    workspaceTargetPath: repo.localPath, branchTarget: branch, dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'running', blockedReason: null, review: null,
    attemptCount: 0, storageAdmissionEpoch: 1,
    launchContext: { source: 'cli', presentation: 'tab', repoContext: 'registered', workMode: 'read-only' },
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath: repo.localPath,
      worktreePath: workspacePath, runtime: 'codex', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-retained-completion', repoPath: repo.localPath, packets: [packet] });
  setLaneStatus(lane.id, 'running');
  const hold = retained ? acquireWorkspaceRetentionHold({ repositoryPath: repo.localPath, repositoryUuid: repo.id,
    worktreeId, packetId, laneId: lane.id, identity, holdId: 'acceptance-evidence',
    reason: 'Retain source for independent completion acceptance.' }) : null;
  const dependencies = { enqueueAutoReview: vi.fn(async () => {}), triggerHeadlessSprintTick: vi.fn(async () => {}),
    queueReviewContinuation: vi.fn(), enqueueVerificationFailureInboxItem: vi.fn(async () => 'unused') };

  return { repo, packet, lane, session, sessionDir, sessionKey, workspacePath, worktreeId, identity, head, tree, hold, remainingWork, exitEvent, runtime, transcriptText, dependencies };
}

describe('retained worker completion through the production supervisor callback', () => {
  it('excludes forgotten completion memory from dependent dispatch after a process restart', async () => {
    await checkForgetDependentDispatch({ root, dataDir, restartRoot, fixture, starts: () => providerStarts.mock.calls.map(call => call[0]) });
    passed = true;
  }, 180_000);

  it('persists a compact private handoff while the active hold retains the completed source', async () => {
    const { packet: { id: packetId }, lane, sessionDir, sessionKey, workspacePath, identity, head, tree, hold, remainingWork, exitEvent, dependencies } = await fixture();

    const decision = await handleAgentCompletion(sessionKey, 'completed', dependencies);
    expect(decision).toMatchObject({ detail: expect.stringContaining('completed its read-only inspection') });
    expect(getLane(lane.id)).toMatchObject({ status: 'completed', outcome: 'no_changes', worktreePath: workspacePath });
    // Terminal cleanup advances through the bounded maintenance scheduler.
    // Wait for its durable refusal receipt before asserting source retention.
    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    const { readMaintenanceState } = await import('@/lib/worktree/maintenance-discovery');
    await vi.waitFor(async () => {
      await runWorktreeMaintenanceTick();
      const receipt = readMaintenanceState<{ outcomes: Array<{ scope: string; outcome: string }> }>('last-pass');
      expect(receipt?.outcomes.some((outcome) => (outcome.scope === lane.id || outcome.scope === workspacePath)
        && outcome.outcome === 'held: preservation, owner, identity or retention policy refused')).toBe(true);
    }, { timeout: 30_000, interval: 50 });
    closeDb();
    expect(getWorkspaceRetentionHold(workspacePath, identity)).toEqual(hold);
    expect(await captureWorktreeMaterializationIdentity(workspacePath)).toEqual(identity);
    expect(git(workspacePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(workspacePath, 'tracked.txt'), 'utf8')).toBe('Read-only completion evidence.\n');
    expect(existsSync(join(sessionDir, 'session.json'))).toBe(true);

    const records = privateHandoffs(getDataDir(), packetId);
    expect(records, 'accepted held completion must persist one private handoff independently of retirement eligibility').toHaveLength(1);
    const record = records[0];
    expect(record.payload).toMatchObject({ packetId, laneId: lane.id });
    expect(record.payload.handoff).toMatchObject({ revision: head, treeSha: tree, outcome: 'no_changes' });
    expect(record.payload.handoff.remainingWork).toContain(remainingWork);
    expect(JSON.stringify(record.payload.handoff.evidence)).toContain(exitEvent.id);
    expect(JSON.stringify(record.payload.handoff.evidence)).toContain('tracked.txt:1');
    expect(record.payload.handoff.sessionIdentities).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: sessionKey }),
    ]));
    const instructions = record.payload.handoff.recoveryInstructions;
    expect(instructions).toContain(workspacePath);
    expect(instructions).toContain(head);
    expect(instructions).toMatch(/git\s+-C/);
    expect(instructions).toMatch(/held|retained/i);
    expect(instructions).toMatch(/provider.*archive/i);
    // Completion has not crossed the retirement writer: its instructions must
    // accurately depend on live source/provider history, not a fictitious bundle.
    expect(instructions).toMatch(/no.*(?:verified|recovery|portable).*bundle|bundle.*(?:not|unavailable)/i);
    const file = lstatSync(record.path);
    const directory = lstatSync(dirname(record.path));
    expect(file.isFile() && !file.isSymbolicLink() && file.nlink === 1).toBe(true);
    expect(file.mode & 0o077).toBe(0);
    expect(directory.isDirectory() && !directory.isSymbolicLink()).toBe(true);
    expect(directory.mode & 0o077).toBe(0);
    if (process.getuid) {
      expect(file.uid).toBe(process.getuid());
      expect(directory.uid).toBe(process.getuid());
    }
    expect(file.size).toBeLessThanOrEqual(16 * 1024);
    // A brand-new Node process has neither the relay Map nor the DB singleton.
    const cold = execFileSync(process.execPath, ['-e',
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", record.path],
    { encoding: 'utf8', timeout: 10_000 });
    expect(JSON.parse(cold)).toEqual(record.payload);
    expect(coldCompletionContext(packetId)).toMatchObject({ packetId, sessionKey, headSha: head,
      selfReview: { residual: remainingWork }, recovery: { source: 'retained-source' } });
    const owner = record.payload as unknown as CompletionHandoffRecord;
    expect(owner).toMatchObject({ sessionKey, identity, owner: {
      attempt: 0, storageEpoch: 1, runId: 'run-retained-completion-1', finishedAt: expect.any(String),
      generation: expect.any(String), turnCursor: expect.any(Number),
    } });
    expect(owner.owner.generation).toContain(lane.id);
    const verify = instructions.split('Verify source with: ')[1].split('. To copy committed source')[0];
    expect(() => execFileSync('sh', ['-c', verify], { cwd: root, stdio: 'pipe', timeout: 10_000 })).not.toThrow();
    const before = readFileSync(record.path);
    await handleAgentCompletion(sessionKey, 'completed', dependencies);
    await capturePacketCompletionContext(packetId, sessionKey);
    expect(privateHandoffs(getDataDir(), packetId)).toHaveLength(1);
    expect(readFileSync(record.path)).toEqual(before);
    expect(lstatSync(record.path).mtimeMs).toBe(file.mtimeMs);
    expect(readCompletionHandoff(owner.repositoryUuid, packetId)?.handoff.revision).toBe(head);
    expect(dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
    passed = true;
  });

  // Measured locally: completion 12.0s, maintenance through 43.2s, and two cold
  // reads plus Git recovery through 58.0s. The old 60s aggregate deadline timed
  // out under contention. Keep each operation's deadline and recovery assertions.
  it('keeps unheld completion on the established automatic retirement and private Git banking path', async () => {
    const started = performance.now();
    const phase = (name: string) => console.log(`[retirement-timing] ${name} elapsedMs=${Math.round(performance.now() - started)}`);
    const f = await fixture(false);
    phase('fixture');
    expect(await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies)).toMatchObject({ detail: expect.stringContaining('completed its read-only inspection') });
    phase('completion');
    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    // Join the bounded retirement job; its real preservation work can outlast a polling deadline.
    await runWorktreeMaintenanceTick();
    phase('maintenance');
    await vi.waitFor(() => expect(getWorkspaceSnapshot(f.repo.id, f.packet.id)?.state).toBe('retired'), { timeout: 15_000, interval: 50 });
    expect(existsSync(f.workspacePath)).toBe(false);
    const handoff = readCompletionHandoff(f.repo.id, f.packet.id);
    expect(handoff?.handoff).toMatchObject({ revision: f.head, treeSha: f.tree, outcome: 'no_changes' });
    const terminal = listWorkspaceSnapshotTransitions(f.repo.id, f.packet.id).findLast((entry) => entry.toState === 'retired');
    const preservationId = terminal?.receipt?.preservationId;
    expect(preservationId).toMatch(/^[a-f0-9]{64}$/);
    const preservation = await readWorkspacePreservation(String(preservationId));
    phase('preservation-read');
    expect(preservation.payload.gitBundle).toMatchObject({ headCommit: f.head, treeSha: f.tree });
    expect(preservation.payload.handoff.revision).toBe(f.head);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toBeNull();
    const historical = JSON.stringify(handoff);
    closeDb();
    const current = coldCompletionContext(f.packet.id);
    phase('cold-recovery-read');
    expect(current.recovery).toMatchObject({ source: 'verified-preservation', preservationId,
      bundleSha256: preservation.payload.gitBundle!.sha256 });
    expect(current.recovery!.instructions).toContain('live-source instructions are historical');
    expect(current.recovery!.instructions).not.toContain('git clone --no-local');
    const destination = join(root, 'cold-retired-recovery');
    const commands = current.recovery!.instructions.split('To recover committed source into a new empty directory: ')[1].split('. Download')[0];
    execFileSync('sh', ['-c', commands.replaceAll('<empty-successor-path>', destination)], { timeout: 10_000, stdio: 'pipe' });
    expect(git(destination, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(git(destination, 'rev-parse', 'HEAD^{tree}')).toBe(f.tree);
    phase('git-recovery');
    const bundle = join(getDataDir(), 'workspace-preservation', 'git-bundles', preservation.payload.gitBundle!.sha256 + '.bundle');
    renameSync(bundle, bundle + '.unavailable');
    try {
      const missing = coldCompletionContext(f.packet.id);
      phase('cold-unavailable-read');
      expect(missing.recovery).toMatchObject({ source: 'unavailable' });
      expect(missing.recovery!.instructions).toContain('instructions are historical');
      expect(missing.recovery!.instructions).not.toMatch(/git (clone|init|fetch)/);
    } finally { renameSync(bundle + '.unavailable', bundle); }
    expect(JSON.stringify(readCompletionHandoff(f.repo.id, f.packet.id))).toBe(historical);
  }, 120_000);

  it('does not republish an older run when a newer turn completes during transcript capture', async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async () => [{ id: 'completion-current', role: 'assistant' as const, text: f.transcriptText, timestamp: new Date() }]);
    read.mockImplementationOnce(async () => { entered(); await waiting; return [{ id: 'completion-old', role: 'assistant', text: f.transcriptText, timestamp: new Date() }]; });
    registerRuntime({ ...f.runtime, readTranscript: read });
    const old = handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
    await started;
    const admitted = recordLaneEvent(f.lane.id, 'steer_run_admitted', 'system', { sessionKey: f.sessionKey });
    const next = { ...f.session, recentRuns: [{ ...f.session.recentRuns[0], id: 'run-retained-completion-2' }, ...f.session.recentRuns],
      runIdentityLedger: { version: 1 as const, totalRuns: 2, complete: true } };
    writeFileSync(join(f.sessionDir, 'session.json'), JSON.stringify(next));
    recordLaneEvent(f.lane.id, 'runtime_process_exit', 'system', { surfaceId: f.sessionKey, exitCode: 0 });
    expect(await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies)).toMatchObject({ detail: expect.stringContaining('completed its read-only inspection') });
    const current = readCompletionHandoff(f.repo.id, f.packet.id)!;
    expect(current.owner.runId).toBe('run-retained-completion-2');
    expect(current.owner.generation).toContain(admitted.id);
    const saved = privateHandoffs(getDataDir(), f.packet.id)[0];
    const bytes = readFileSync(saved.path);
    release();
    expect(await old).toMatchObject({ superseded: true });
    expect(readFileSync(saved.path)).toEqual(bytes);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
  });

  it('refuses a replaced owner, materialization or live provider run during completion capture', async () => {
    for (const replacement of ['session', 'generation', 'materialization', 'provider'] as const) {
      const f = await fixture();
      registerRuntime({ ...f.runtime, readTranscript: async () => {
        if (replacement === 'session') updateLane(f.lane.id, { sessionKey: f.sessionKey + '-new' });
        else if (replacement === 'generation') {
          const mission = readOrchestratorControlPlaneState();
          mission.packets[0].attemptCount = 1;
          mission.packets[0].storageAdmissionEpoch = 2;
          writeOrchestratorControlPlaneState(mission);
        } else if (replacement === 'materialization') {
          renameSync(f.workspacePath, f.workspacePath + '-original');
          execFileSync('git', ['clone', '--no-local', f.repo.localPath, f.workspacePath], { stdio: 'pipe', timeout: 10_000 });
        } else {
          writeFileSync(join(f.sessionDir, 'session.json'), JSON.stringify({ ...f.session,
            activeRun: { ...f.session.recentRuns[0], id: 'new-live-run', outcome: 'running', finishedAt: undefined } }));
        }
        return [{ id: 'stale', role: 'assistant', text: f.transcriptText, timestamp: new Date() }];
      } });
      await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
      expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
      expect(getLane(f.lane.id)?.status).not.toBe('completed');
      expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
      expect(existsSync(f.workspacePath)).toBe(true);
      expect(f.dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    }
  });

  it('preserves a rebound session owner handoff when the old completion returns later', async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    registerRuntime({ ...f.runtime, readTranscript: async () => {
      entered(); await waiting;
      return [{ id: 'old-owner', role: 'assistant', text: f.transcriptText, timestamp: new Date() }];
    } });
    const old = handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
    await started;
    const sessionKey = f.sessionKey + '-replacement';
    const sessionDir = join(sessionsRoot, sessionKey.slice('codex-owned:'.length));
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ ...f.session, surfaceId: sessionKey, sessionDir,
      recentRuns: [{ ...f.session.recentRuns[0], id: 'replacement-run' }] }), { mode: 0o600 });
    updateLane(f.lane.id, { sessionKey });
    await withWorktreeMetaTransaction(f.repo.localPath, async (transaction) => {
      const metadata = (await transaction.readAll())[f.worktreeId];
      await transaction.save(f.worktreeId, { ...metadata, sessionKey });
    });
    const mission = readOrchestratorControlPlaneState();
    mission.packets[0].lane!.sessionKey = sessionKey;
    writeOrchestratorControlPlaneState(mission);
    recordLaneEvent(f.lane.id, 'runtime_process_exit', 'system', { surfaceId: sessionKey, exitCode: 0 });
    registerRuntime({ ...f.runtime, readTranscript: async () => [{ id: 'new-owner', role: 'assistant',
      text: f.transcriptText.replaceAll(f.sessionKey, sessionKey), timestamp: new Date() }] });
    await handleAgentCompletion(sessionKey, 'completed', f.dependencies);
    const current = readCompletionHandoff(f.repo.id, f.packet.id)!;
    expect(current).toMatchObject({ sessionKey, owner: { runId: 'replacement-run' } });
    const path = privateHandoffs(getDataDir(), f.packet.id)[0].path;
    const bytes = readFileSync(path);
    release();
    expect(await old).toMatchObject({ superseded: true });
    expect(readFileSync(path)).toEqual(bytes);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
  });

  it('keeps the first accepted review capture immutable and rejects unsafe private destinations', async () => {
    const f = await fixture();
    setLaneStatus(f.lane.id, 'reviewing');
    await capturePacketCompletionContext(f.packet.id, f.sessionKey);
    const saved = privateHandoffs(getDataDir(), f.packet.id)[0];
    const before = readFileSync(saved.path), modifiedAt = lstatSync(saved.path).mtimeMs;
    await capturePacketCompletionContext(f.packet.id, f.sessionKey);
    expect(readFileSync(saved.path)).toEqual(before);
    expect(lstatSync(saved.path).mtimeMs).toBe(modifiedAt);
    expect((await readPacketCompletionContext(f.packet.id))?.sessionKey).toBe(f.sessionKey);
    // Advance source within the same completed provider run: no rewriting the
    // already accepted source receipt under that run's identity.
    git(f.workspacePath, 'commit', '--allow-empty', '-qm', 'source moved after accepted run');
    await expect(capturePacketCompletionContext(f.packet.id, f.sessionKey)).rejects.toThrow(/source changed/);
    expect(readFileSync(saved.path)).toEqual(before);
    chmodSync(saved.path, 0o644);
    expect(() => readCompletionHandoff(f.repo.id, f.packet.id)).toThrow(/unsafe ownership/);
    chmodSync(saved.path, 0o600);
    renameSync(saved.path, saved.path + '.retained');
    symlinkSync(saved.path + '.retained', saved.path);
    expect(() => readCompletionHandoff(f.repo.id, f.packet.id)).toThrow();
    expect(readFileSync(saved.path + '.retained')).toEqual(before);
  });

  it('bounds remaining work and evidence without invoking a model or copying recovery banks', async () => {
    const f = await fixture();
    const review = { passed: false, confidence: 'medium', summary: 'Summary '.repeat(400),
      outcome: 'Partial inspection '.repeat(300), residual: 'Remaining '.repeat(400),
      issuesFound: Array.from({ length: 20 }, (_, i) => `issue ${i}: ${'x'.repeat(500)}`),
      evidence: Array.from({ length: 20 }, (_, i) => `tracked.txt:${i + 1}; ${'e'.repeat(500)}`),
      decision: 'partial', recurrenceProtection: 'Focused regression' };
    const read = vi.fn(async () => [{ id: 'large-context', role: 'assistant' as const,
      text: `<self-review>${JSON.stringify(review)}</self-review>`, timestamp: new Date() }]);
    registerRuntime({ ...f.runtime, readTranscript: read });
    setLaneStatus(f.lane.id, 'reviewing');
    await capturePacketCompletionContext(f.packet.id, f.sessionKey);
    const saved = privateHandoffs(getDataDir(), f.packet.id)[0];
    const record = readCompletionHandoff(f.repo.id, f.packet.id)!;
    expect(record.handoff.outcome).toBe('partial');
    expect(record.handoff.remainingWork.length).toBeLessThanOrEqual(1200);
    expect(record.handoff.evidence.references.length).toBeLessThanOrEqual(11);
    expect(record.context.selfReview?.evidence?.length).toBeLessThanOrEqual(8);
    expect(record.context.selfReview?.issuesFound?.length).toBeLessThanOrEqual(8);
    expect(lstatSync(saved.path).size).toBeLessThanOrEqual(16 * 1024);
    expect(record.handoff.recoveryInstructions).toContain('No verified portable recovery bundle');
    expect(read).toHaveBeenCalledTimes(1);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
  });

  it('preserves the supervisor own bounded retry generation transition', async () => {
    const f = await fixture();
    writeFileSync(join(f.workspacePath, 'tracked.txt'), 'Small edit awaiting verification.\n');
    git(f.workspacePath, 'commit', '-qam', 'fixture edit');
    const mission = readOrchestratorControlPlaneState();
    mission.packets[0].launchContext!.workMode = 'edit';
    mission.packets[0].maxAttempts = 2;
    writeOrchestratorControlPlaneState(mission);
    // Only the heavy verification command is stubbed in this retry case;
    // completion, attempt learning, owner guard and requeue persistence stay real.
    const verification = await import('@/lib/supervisor/completion-verification');
    const verify = vi.spyOn(verification, 'runCompletionVerification').mockResolvedValueOnce({
      ok: false, kind: 'typecheck', output: 'fixture.ts:1: synthetic verification failure',
    });
    try {
      const result = await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
      expect(result).toBeUndefined();
      expect(readOrchestratorControlPlaneState().packets[0].attemptCount).toBe(1);
      expect(f.dependencies.triggerHeadlessSprintTick).toHaveBeenCalledTimes(1);
      expect(f.dependencies.enqueueVerificationFailureInboxItem).not.toHaveBeenCalled();
      expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
      expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
    } finally { verify.mockRestore(); }
  });

  it('advances a review capture to the accepted no_changes outcome for the same immutable source', async () => {
    const f = await fixture();
    setLaneStatus(f.lane.id, 'reviewing');
    await capturePacketCompletionContext(f.packet.id, f.sessionKey);
    expect(readCompletionHandoff(f.repo.id, f.packet.id)).toMatchObject({ acceptedState: 'reviewing', handoff: { outcome: 'succeeded' } });
    expect(await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies)).toMatchObject({
      detail: expect.stringContaining('completed its read-only inspection'),
    });
    expect(readCompletionHandoff(f.repo.id, f.packet.id)).toMatchObject({
      acceptedState: 'completed', owner: { runId: 'run-retained-completion-1' },
      handoff: { revision: f.head, treeSha: f.tree, outcome: 'no_changes' },
    });
    expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(1);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
  });

  it('accepts normal launch-produced null UUID binding through the held silent-exit review entry', async () => {
    const f = await fixture();
    writeFileSync(join(f.workspacePath, 'tracked.txt'), 'Actual launch completion source.\n');
    git(f.workspacePath, 'commit', '-qam', 'launch fixture edit');
    const mission = readOrchestratorControlPlaneState();
    mission.packets[0].launchContext!.workMode = 'edit';
    writeOrchestratorControlPlaneState(mission);
    const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
    const adapter: OwnedRuntimeAdapter = {
      runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
      rootDefault: sessionsRoot, binaryName: process.execPath, binaryEnvOverride: 'O8_TEST_HANDOFF_BINARY',
      humanLabel: 'Completion launch fixture', squadShortName: 'Codex',
      launchArgs: ({ sessionDir }) => ['-e', `process.stdout.write(${JSON.stringify(f.transcriptText.replaceAll(f.sessionKey, 'codex-owned:' + basename(sessionDir!)))})`], resumeArgs: () => null,
      parseRunLog: (raw) => ({ entries: [{ id: 'actual-node-exit', kind: 'message', label: 'Assistant', text: raw, timestamp: new Date().toISOString() }],
        outcome: 'finished', completedTurn: true }),
    };
    const store = createOwnedSessionStore(adapter);
    const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
    const previousBinary = process.env.O8_TEST_HANDOFF_BINARY;
    process.env.O8_TEST_HANDOFF_BINARY = process.execPath;
    invalidateCliCache('codex');
    let launch: Awaited<ReturnType<typeof store.launch>>;
    try {
      launch = await store.launch({ cwd: f.workspacePath, prompt: 'Completion binding fixture',
        packetId: f.packet.id, laneId: f.lane.id, model: 'gpt-6.1-sol', effort: 'high', runtimeConfig: { workMode: 'edit' } });
    } finally {
      if (previousBinary === undefined) delete process.env.O8_TEST_HANDOFF_BINARY;
      else process.env.O8_TEST_HANDOFF_BINARY = previousBinary;
      invalidateCliCache('codex');
    }
    expect(launch.ok).toBe(true);
    const key = launch.surfaceId!;
    const directory = join(sessionsRoot, key.slice('codex-owned:'.length));
    let session!: OwnedSessionRecord;
    await vi.waitFor(() => {
      session = JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8'));
      expect(session.activeRun).toBeUndefined();
      expect(session.recentRuns[0]).toMatchObject({ outcome: 'finished', childExit: { code: 0 } });
    }, { timeout: 15_000, interval: 50 });
    expect(session.workspaceBinding).toMatchObject({ repositoryUuid: null, packetId: f.packet.id,
      logicalWorkspaceId: 'packet:' + f.packet.id, cwd: f.workspacePath });
    updateLane(f.lane.id, { sessionKey: key });
    await withWorktreeMetaTransaction(f.repo.localPath, async (transaction) => {
      await transaction.save(f.worktreeId, { ...(await transaction.readAll())[f.worktreeId], sessionKey: key });
    });
    const current = readOrchestratorControlPlaneState();
    current.packets[0].lane!.sessionKey = key;
    writeOrchestratorControlPlaneState(current);
    registerRuntime({ ...f.runtime, readTranscript: async () => [{ id: 'actual-node-exit', role: 'assistant',
      text: readFileSync(session.recentRuns[0].stdoutPath, 'utf8'), timestamp: new Date() }] });
    const { runSilentExitTriageForLane } = await import('@/lib/supervisor/silent-exit-detector');
    expect(await runSilentExitTriageForLane(f.lane.id)).toBe(true);
    const record = readCompletionHandoff(f.repo.id, f.packet.id)!;
    expect(record).toMatchObject({ acceptedState: 'reviewing', sessionKey: key,
      owner: { runId: session.recentRuns[0].id }, handoff: { revision: git(f.workspacePath, 'rev-parse', 'HEAD') } });
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    const saved = privateHandoffs(getDataDir(), f.packet.id)[0].path;
    const bytes = readFileSync(saved), modified = lstatSync(saved).mtimeMs;
    await capturePacketCompletionContext(f.packet.id, key);
    expect(readFileSync(saved)).toEqual(bytes);
    expect(lstatSync(saved).mtimeMs).toBe(modified);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
    expect(existsSync(f.workspacePath)).toBe(true);
  });

  it('refuses mismatched UUID, logical workspace and binding cwd at the real completion entry', async () => {
    for (const binding of ['uuid', 'logical', 'cwd'] as const) {
      const f = await fixture();
      f.session.workspaceBinding!.repositoryUuid = binding === 'uuid' ? 'wrong-repository' : null;
      if (binding === 'logical') f.session.workspaceBinding!.logicalWorkspaceId = 'packet:another-owner';
      if (binding === 'cwd') f.session.workspaceBinding!.cwd = f.repo.localPath;
      writeFileSync(join(f.sessionDir, 'session.json'), JSON.stringify(f.session));
      await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
      expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
      expect(getLane(f.lane.id)?.status).not.toBe('completed');
      expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
    }
  });

  it('refuses substituted private parents before relative create or rename without outside mutation', async () => {
    for (const operation of ['prepare', 'publish']) {
      const f = await fixture();
      const bank = join(getDataDir(), 'completion-handoffs');
      mkdirSync(bank, { recursive: true, mode: 0o700 });
      const outside = join(root, 'outside-' + fixtureIndex);
      mkdirSync(outside, { mode: 0o700 });
      const name = createHash('sha256').update(JSON.stringify([f.repo.id, f.packet.id])).digest('hex') + '.json';
      writeFileSync(join(outside, name), 'outside sentinel', { mode: 0o600 });
      let substituted = false;
      publicationRace.before = (request) => {
        if (!substituted && request.operation === operation && request.identity?.canonicalPath === bank) {
          substituted = true;
          renameSync(bank, bank + '.original');
          symlinkSync(outside, bank);
        }
      };
      try {
        await handleAgentCompletion(f.sessionKey, 'completed', f.dependencies);
        expect(substituted).toBe(true);
        expect(readFileSync(join(outside, name), 'utf8')).toBe('outside sentinel');
        expect(readdirSync(outside)).toEqual([name]);
        expect(getLane(f.lane.id)?.status).not.toBe('completed');
      } finally {
        publicationRace.before = null;
        if (substituted) { unlinkSync(bank); renameSync(bank + '.original', bank); }
      }
      expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
      expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
      expect(existsSync(f.workspacePath)).toBe(true);
    }
  });

  it('publishes a valid held completion while refusing an unrelated FIFO session without touching it', async () => {
    const f = await fixture();
    setLaneStatus(f.lane.id, 'reviewing');
    const sibling = join(sessionsRoot, 'unreadable-sibling');
    mkdirSync(sibling);
    const fifo = join(sibling, 'session.json');
    execFileSync('mkfifo', ['-m', '600', fifo], { timeout: 2_000 });
    const identity = lstatSync(fifo);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        capturePacketCompletionContext(f.packet.id, f.sessionKey),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Sibling FIFO stalled completion publication.')), 5_000); }),
      ]);
      const record = readCompletionHandoff(f.repo.id, f.packet.id)!;
      expect(record).toMatchObject({ sessionKey: f.sessionKey, acceptedState: 'reviewing' });
      const after = lstatSync(fifo);
      expect(after.isFIFO()).toBe(true);
      expect([after.dev, after.ino, after.mode, after.size]).toEqual([identity.dev, identity.ino, identity.mode, identity.size]);
      expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
      const { lookupOwnedActiveRunFresh } = await import('@/lib/runtimes/shared/owned-session-index');
      await expect(lookupOwnedActiveRunFresh('codex-owned:unreadable-sibling')).rejects.toThrow('unreadable metadata');
    } finally {
      clearTimeout(timeout);
      unlinkSync(fifo);
    }
  });

  it('promptly refuses provider and private-bank FIFO substitutions through cold production capture', async () => {
    for (const target of ['provider', 'handoff']) {
      const f = await fixture();
      setLaneStatus(f.lane.id, 'reviewing');
      const bank = join(getDataDir(), 'completion-handoffs');
      mkdirSync(bank, { recursive: true, mode: 0o700 });
      const name = createHash('sha256').update(JSON.stringify([f.repo.id, f.packet.id])).digest('hex') + '.json';
      const fifo = target === 'provider' ? join(f.sessionDir, 'session.json') : join(bank, name);
      if (target === 'provider') renameSync(fifo, fifo + '.original');
      execFileSync('mkfifo', ['-m', '600', fifo], { timeout: 2_000 });
      const start = Date.now();
      const code = `
        const unwrap = (m) => m.default ?? m;
        const runtimes = unwrap(await import('./src/lib/runtimes/index.ts'));
        runtimes.registerRuntime({ id: 'codex', kind: 'codex', displayName: 'FIFO fixture', capabilities: {},
          readTranscript: async () => [{ id: 'fifo-context', role: 'assistant', text: process.argv[3], timestamp: new Date() }],
          getChangedFiles: async () => [] });
        const relay = unwrap(await import('./src/lib/orchestrator/context-relay.ts'));
        try { await relay.capturePacketCompletionContext(process.argv[1], process.argv[2]);
          process.stdout.write('\\nFIFO_RESULT:accepted'); }
        catch (error) { process.stdout.write('\\nFIFO_RESULT:refused:' + error.message); }
        process.exit(0);
      `;
      try {
        const result = execFileSync(process.execPath, ['--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'),
          '--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', code,
          f.packet.id, f.sessionKey, f.transcriptText], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' },
          encoding: 'utf8', timeout: 15_000 });
        expect(result.split('FIFO_RESULT:').at(-1)).toMatch(/^refused:[\s\S]*(?:unsafe|ownership)/);
        expect(Date.now() - start).toBeLessThan(15_000);
        expect(lstatSync(fifo).isFIFO()).toBe(true);
        expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
        expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
      } finally {
        unlinkSync(fifo);
        if (target === 'provider') renameSync(fifo + '.original', fifo);
      }
    }
  });

  it.each(['salvage', 'already-merged'] as const)('publishes held %s completion at its accepted silent-exit transition', async (route) => {
    const { runSilentExitTriageForLane } = await import('@/lib/supervisor/silent-exit-detector');
    const verification = await import('@/lib/supervisor/completion-verification');
    const f = await fixture();
    const mission = readOrchestratorControlPlaneState();
    mission.packets[0].launchContext!.workMode = 'edit';
    writeOrchestratorControlPlaneState(mission);
    writeFileSync(join(f.workspacePath, 'tracked.txt'), 'Silent-exit committed source.\n');
    if (route === 'already-merged') {
      git(f.workspacePath, 'commit', '-qam', 'completed work already on remote main');
      const remote = join(root, 'remote-' + fixtureIndex);
      git(root, 'clone', '--bare', '-q', f.workspacePath, remote);
      git(remote, 'update-ref', 'refs/heads/main', 'HEAD');
      git(f.workspacePath, 'remote', 'add', 'origin', remote);
    }
    // Provider output/liveness and all triage/salvage/merge decisions remain real;
    // only the heavy repository verification command is replaced here.
    const verify = vi.spyOn(verification, 'runCompletionVerification').mockResolvedValue({ ok: true, kind: 'typecheck', output: '' });
    try { expect(await runSilentExitTriageForLane(f.lane.id)).toBe(true); } finally { verify.mockRestore(); }
    const record = readCompletionHandoff(f.repo.id, f.packet.id)!;
    expect(record).toMatchObject({ acceptedState: route === 'salvage' ? 'reviewing' : 'completed',
      sessionKey: f.sessionKey, owner: { runId: f.session.recentRuns[0].id },
      handoff: { revision: git(f.workspacePath, 'rev-parse', 'HEAD'), treeSha: git(f.workspacePath, 'rev-parse', 'HEAD^{tree}') } });
    if (route === 'already-merged') expect(record.handoff.outcome).toBe('already_merged');
    expect(getLane(f.lane.id)?.status).toBe(route === 'salvage' ? 'reviewing' : 'completed');
    if (route === 'already-merged') {
      expect(getLaneEvents(f.lane.id, 100)).toEqual(expect.arrayContaining([
        expect.objectContaining({ verb: 'silent_exit_already_merged', payload: expect.objectContaining({ headSha: record.handoff.revision }) }),
      ]));
    }
    const saved = privateHandoffs(getDataDir(), f.packet.id)[0].path;
    const bytes = readFileSync(saved), modified = lstatSync(saved).mtimeMs;
    await capturePacketCompletionContext(f.packet.id, f.sessionKey);
    expect(readFileSync(saved)).toEqual(bytes);
    expect(lstatSync(saved).mtimeMs).toBe(modified);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
    expect(existsSync(f.workspacePath)).toBe(true);
    expect(git(f.workspacePath, 'status', '--porcelain')).toBe('');
  });

  it('refuses a newer owner generation during actual silent-exit capture before acceptance', async () => {
    const f = await fixture();
    git(f.workspacePath, 'commit', '--allow-empty', '-qm', 'silent-exit work awaiting review');
    registerRuntime({ ...f.runtime, readTranscript: async () => {
      const mission = readOrchestratorControlPlaneState();
      mission.packets[0].attemptCount = 1;
      mission.packets[0].storageAdmissionEpoch = 2;
      writeOrchestratorControlPlaneState(mission);
      return [{ id: 'superseded-silent-exit', role: 'assistant', text: f.transcriptText, timestamp: new Date() }];
    } });
    const { runSilentExitTriageForLane } = await import('@/lib/supervisor/silent-exit-detector');
    await expect(runSilentExitTriageForLane(f.lane.id)).rejects.toThrow(/superseded/);
    expect(getLane(f.lane.id)?.status).toBe('running');
    expect(privateHandoffs(getDataDir(), f.packet.id)).toHaveLength(0);
    expect(getWorkspaceRetentionHold(f.workspacePath, f.identity)).toEqual(f.hold);
    expect(existsSync(f.workspacePath)).toBe(true);
  });

});
