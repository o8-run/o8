import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
const priorOwnedRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
const ownedRoot = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-canonical-owned-')));
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;

const { recordMission } = await import('@/lib/db/missions-store');
const operatorCheckoutMerge = await import('@/lib/lane/operator-checkout-merge');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const {
  approveAndMergePacket,
  getMissionStatus,
  submitPacketReview,
} = await import('@/lib/orchestrator/operator-mission-service');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { addRepo } = await import('@/lib/repos/registry');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { worktreeRepoKey } = await import('@/lib/worktree/root-layout');
const {
  listWorkspaceSnapshotTransitions,
  listWorkspaceSnapshotsByOriginalPath,
} = await import('@/lib/worktree/snapshot-state');

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function packetFixture(packetId: string, canonicalRepo: string, branch: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: 'PKT-CANONICAL-MERGE',
    title: 'publish a relocated packet clone',
    summary: 'Exercise canonical direct-merge publication.',
    status: 'awaiting_review',
    queueState: 'queued',
    releaseState: 'pending',
    workspaceTargetPath: canonicalRepo,
    branchTarget: branch,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: null,
    lastEventAt: null,
    lastEventLabel: null,
  } as OrchestratorPacket;
}

async function createRelocatedCloneMission(label: string, incompleteDependencies = false) {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), `o8-direct-merge-${label}-`)));
  const origin = join(root, 'github-like.git');
  const canonicalRepo = join(root, 'canonical');
  const packetId = `pkt-canonical-${label}-${Date.now()}`;
  const branch = `issue/canonical-${label}-${Date.now()}`;
  roots.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, canonicalRepo], { stdio: 'pipe' });
  git(canonicalRepo, ['checkout', '-b', 'main']);
  git(canonicalRepo, ['config', 'user.name', 'o8-test']);
  git(canonicalRepo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(canonicalRepo, 'base.txt'), 'base\n');
  if (incompleteDependencies) {
    mkdirSync(join(canonicalRepo, 'src'), { recursive: true });
    writeFileSync(join(canonicalRepo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(canonicalRepo, 'package.json'), JSON.stringify({
      name: 'merge-dependency-fixture',
      private: true,
      scripts: { lint: 'gate-check', typecheck: 'tsc --noEmit' },
    }));
    writeFileSync(join(canonicalRepo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { noEmit: true, strict: true },
      include: ['src/**/*.ts'],
    }));
    writeFileSync(join(canonicalRepo, 'src', 'index.ts'), 'export const ready: string = "yes";\n');
  }
  const baseSha = commitAll(canonicalRepo, 'base');
  git(canonicalRepo, ['push', '-u', 'origin', 'main']);

  const relocatedBase = join(
    process.env.CORTEX_IDE_DATA_DIR!,
    'worktrees',
    worktreeRepoKey(canonicalRepo),
    '.cortex-worktrees',
  );
  mkdirSync(relocatedBase, { recursive: true });
  const packetClone = join(relocatedBase, `packet-${packetId}`);
  execFileSync('git', ['clone', origin, packetClone], { stdio: 'pipe' });
  git(packetClone, ['checkout', '-b', branch, 'origin/main']);
  git(packetClone, ['config', 'user.name', 'o8-test']);
  git(packetClone, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(packetClone, 'feature.txt'), `${label}\n`);
  const packetSha = commitAll(packetClone, `feat: ${label} [via-o8]`);
  const typecheckMarker = join(root, 'typecheck-ran');
  if (incompleteDependencies) {
    const binDir = join(packetClone, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const tscPath = join(binDir, 'tsc');
    writeFileSync(tscPath, [
      '#!/bin/sh',
      `touch ${JSON.stringify(typecheckMarker)}`,
      'echo "src/index.ts(1,1): error TS2307: Cannot find module gate-check"',
      'exit 2',
      '',
    ].join('\n'));
    chmodSync(tscPath, 0o755);
    // The merge typecheck runs the repository install's compiler. It fails, so
    // a typecheck that ran would leave the marker and take the layer-1 retry.
    const compiler = join(canonicalRepo, 'node_modules', 'typescript', 'bin', 'tsc');
    mkdirSync(join(compiler, '..'), { recursive: true });
    writeFileSync(compiler, [
      `try { require('node:fs').writeFileSync(${JSON.stringify(typecheckMarker)}, ''); } catch {}`,
      'console.log("src/index.ts(1,1): error TS2307: Cannot find module gate-check");',
      'process.exit(2);',
      '',
    ].join('\n'));
  }

  const registeredRepo = await addRepo(realpathSync.native(canonicalRepo));
  // Declare a real idle owned session. No provider runs were launched; the
  // persisted complete empty run ledger permits native quiescence proof.
  const sessionId = `codex-owned-${packetId}`;
  const sessionKey = `codex-owned:${sessionId}`;
  const sessionDir = join(ownedRoot, sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: sessionKey, packetId, sessionDir, cwd: packetClone, repoPath: packetClone,
    branch, head: packetSha, title: 'Idle publication fixture', createdAt: now, updatedAt: now,
    recentRuns: [], latestPrompt: 'Verify canonical publication and retirement.',
    latestSummary: 'Idle fixture; zero provider executions.',
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: { logicalWorkspaceId: `packet:${packetId}`, repositoryUuid: registeredRepo.id,
      packetId, cwd: packetClone, version: 1, verifiedAt: now },
  }), { flag: 'wx', mode: 0o600 });
  const worktreeId = `packet-${packetId}`;
  const materializationIdentity = await captureWorktreeMaterializationIdentity(packetClone);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(relocatedBase);
  await withWorktreeMetaTransaction(canonicalRepo, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    sessionKey,
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: `Canonical merge ${label}`,
    branchName: branch,
    status: 'ready',
    isolationKind: 'apfs-cow-clone',
    materializationIdentity,
    materializationParentIdentity,
  }));
  const lane = createLane({
    repoPath: canonicalRepo,
    worktreePath: packetClone,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey,
    label: `Canonical merge ${label}`,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

  const packet = packetFixture(packetId, canonicalRepo, branch);
  const missionId = `mission-canonical-${label}-${Date.now()}`;
  const mission: OrchestratorMissionState = {
    ...createEmptyOrchestratorMissionState(),
    missionId,
    repoPath: canonicalRepo,
    prompt: 'Canonical direct merge real path',
    summary: 'Canonical direct merge real path',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  };
  recordMission({
    id: missionId,
    repoPath: canonicalRepo,
    runtime: 'codex',
    prompt: mission.prompt,
    summary: mission.summary,
    constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState: mission,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(mission);

  return { baseSha, branch, canonicalRepo, lane, missionId, packetClone, packetId, packetSha, typecheckMarker,
    canonicalPacketPath: materializationIdentity.canonicalPath };
}

async function reviewAndMerge(fixture: Awaited<ReturnType<typeof createRelocatedCloneMission>>) {
  await submitPacketReview({
    packetId: fixture.packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: fixture.packetSha,
  });
  return approveAndMergePacket({
    packetId: fixture.packetId,
    expectedHeadSha: fixture.packetSha,
    actor: 'user',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (priorOwnedRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  else process.env.CORTEX_IDE_OWNED_CODEX_ROOT = priorOwnedRoot;
  rmSync(ownedRoot, { recursive: true, force: true });
});

describe('direct merge publishes through the canonical mission repository', () => {
  it('lands a relocated full-clone packet commit on canonical main', async () => {
    const fixture = await createRelocatedCloneMission('success');
    const diagnostics: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      diagnostics.push(args.map(String).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      diagnostics.push(args.map(String).join(' '));
    });
    expect(git(fixture.packetClone, ['remote', 'get-url', 'origin'])).not.toBe(fixture.canonicalRepo);

    try {
      const result = await reviewAndMerge(fixture);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const lane = getLane(fixture.lane.id);
      const terminalEvents = getLaneEvents(fixture.lane.id)
        .filter((event) => event.verb === 'status_change')
        .map((event) => event.payload.status)
        .filter((status) => status === 'completed' || status === 'archived');
      const mission = await getMissionStatus({ missionId: fixture.missionId, includeCost: false });
      const snapshots = listWorkspaceSnapshotsByOriginalPath(fixture.canonicalPacketPath);
      const creation = snapshots[0]
        ? listWorkspaceSnapshotTransitions(snapshots[0].repositoryUuid, snapshots[0].packetId)[0]
        : undefined;

      expect(result.merged).toBe(true);
      expect(git(fixture.canonicalRepo, ['merge-base', '--is-ancestor', fixture.packetSha, 'main'])).toBe('');
      expect(git(fixture.canonicalRepo, ['rev-parse', 'main'])).toBe(fixture.packetSha);
      expect(existsSync(fixture.packetClone), diagnostics.join('\n')).toBe(false);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        state: 'retired',
        headCommit: fixture.packetSha,
      });
      expect(snapshots[0]!.diffFingerprint).toBeTruthy();
      expect(git(fixture.canonicalRepo, ['rev-parse', snapshots[0]!.recoveryRef])).toBe(fixture.packetSha);
      expect(creation?.receipt).toMatchObject({
        mergeCandidateSha: fixture.packetSha,
        reviewedHeadSha: fixture.packetSha,
      });
      expect(lane).toMatchObject({ status: 'archived', outcome: 'merged' });
      expect(terminalEvents).toEqual(['archived']);
      expect(mission.packets.find((packet) => packet.id === fixture.packetId)).toMatchObject({
        status: 'released',
        releaseState: 'released',
      });
      expect(diagnostics.filter((diagnostic) => (
        diagnostic.includes('[worktree-capture]')
        || diagnostic.includes('Failed to preserve head')
        || diagnostic.includes('REFUSED preservation boundary')
        || diagnostic.includes('REFUSED durable retirement begin')
        || diagnostic.includes('Refusing to transition lane')
      ))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 60_000);

  it('blocks and escalates when canonical main loses the candidate after git merge succeeds', async () => {
    const fixture = await createRelocatedCloneMission('postcondition');
    // Canonical main loses the candidate right after o8's fast-forward merge.
    const fastForward = operatorCheckoutMerge.fastForwardBaseBranch;
    vi.spyOn(operatorCheckoutMerge, 'fastForwardBaseBranch').mockImplementation(async (input) => {
      const merged = await fastForward(input);
      git(fixture.canonicalRepo, ['reset', '--hard', fixture.baseSha]);
      return merged;
    });

    const result = await reviewAndMerge(fixture);
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === fixture.packetId);

    expect(result).toMatchObject({
      merged: false,
      reason: 'canonical_merge_ancestry_failed',
    });
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
    });
    expect(getLane(fixture.lane.id)?.outcome).not.toBe('merged');
    expect(packet).toMatchObject({
      status: 'blocked',
      blockedReason: 'canonical_merge_ancestry_failed',
    });
    expect(git(fixture.canonicalRepo, ['rev-parse', 'main'])).toBe(fixture.baseSha);
  }, 30_000);

  it('blocks an incomplete dependency tree before post-rebase typecheck consumes its retry', async () => {
    const fixture = await createRelocatedCloneMission('incomplete-dependencies', true);

    const result = await reviewAndMerge(fixture);
    const packet = readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === fixture.packetId);
    const events = getLaneEvents(fixture.lane.id);

    expect(result).toMatchObject({
      merged: false,
      reason: 'dependency_materialization_incomplete',
    });
    expect(result.note).toContain('gate-check');
    expect(existsSync(fixture.typecheckMarker)).toBe(false);
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
      lastEventLabel: 'dependency_materialization_incomplete',
    });
    expect(packet?.typecheckAutoRetries ?? 0).toBe(0);
    expect(packet?.blockedReason).toContain('dependency_materialization_incomplete');
    expect(events.some((event) => event.verb === 'typecheck_auto_retry')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'dependency_materialization_incomplete',
        payload: expect.objectContaining({
          phase: 'merge_gate',
          missingBinaries: ['gate-check'],
          verifiedBinaries: ['tsc'],
        }),
      }),
    ]));
    expect(git(fixture.canonicalRepo, ['rev-parse', 'main'])).toBe(fixture.baseSha);
  }, 30_000);
});
