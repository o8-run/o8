import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-problem-service-'));
const repoPath = join(dataDir, 'repo');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

execFileSync('mkdir', ['-p', repoPath]);
execFileSync('git', ['init', '-q', repoPath]);

const { closeDb, getSqlite } = await import('@/lib/db');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { addRepoToProject, createProject } = await import('@/lib/projects/store');
const { addRepo } = await import('@/lib/repos/registry');
const { enqueueInboxItem, listInboxItems } = await import('@/lib/supervisor/inbox');
const { getTaskPool } = await import('@/lib/tasks/pool');
const { handleProblemGet, handleProblemList } = await import('@/lib/mcp/operator-handlers/problems');
const { recordOutgoingMissionSnapshot } = await import('@/lib/orchestrator/operator-mission-service/mission-handoff');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { getProblemDossier, listProblemDossiers, listProblemRemedies } = await import('./dossiers');
const problemDossierRoute = await import('@/app/api/panel/problem-dossiers/route');
const {
  acceptProblemDossier,
  reconcileProblemDossiers,
  resumeProblemDossier,
  stopProblemDossier,
  suppressProblemDossier,
} = await import('./service');

let testProjectId = '';
const operatorAuthorization = `Bearer ${getOrCreateWsToken()}`;

beforeAll(async () => {
  const repo = await addRepo(repoPath);
  const project = createProject({ name: 'Problem fixture', mainRepoId: repo.id });
  addRepoToProject(project.id, repo.id, 'fullstack');
  testProjectId = project.id;
  listProblemDossiers({ includeSuppressed: true });
  listInboxItems({ includeAllProjects: true, includeDismissed: true });
});

async function resetFixture(): Promise<void> {
  getSqlite().exec(`
    DELETE FROM problem_remedies;
    DELETE FROM problem_evidence;
    DELETE FROM problem_dossiers;
    DELETE FROM supervisor_inbox;
    DELETE FROM lane_events;
    DELETE FROM lanes;
    DELETE FROM missions;
  `);
  await withLockedState((state) => {
    state.packets = [];
    state.missionId = `problem-test-${Date.now()}`;
    state.repoPath = repoPath;
    state.prompt = 'Problem dossier fixture';
    state.summary = 'Problem dossier fixture';
    state.updatedAt = new Date().toISOString();
  });
}

function enqueueFailure(packetId: string, error: string): void {
  enqueueInboxItem({
    repoPath,
    packetId,
    kind: 'verification_failed',
    payload: { verificationKind: 'typecheck', error },
  });
}

function enqueueMissingEnding(packetId: string): void {
  enqueueInboxItem({
    repoPath,
    packetId,
    kind: 'packet_no_changes',
    status: 'human_required',
    payload: { note: 'Archived without a recorded ending' },
  });
}

function createDossier(error: string, prefix: string) {
  for (const suffix of ['a', 'b', 'c']) enqueueFailure(`${prefix}-${suffix}`, error);
  const dossier = listProblemDossiers({ includeSuppressed: true })
    .find((candidate) => candidate.painStatement.includes(error.toLowerCase()));
  if (!dossier) throw new Error(`Fixture did not create dossier for ${error}`);
  getSqlite().prepare('UPDATE problem_dossiers SET project_id = ? WHERE id = ?')
    .run(testProjectId, dossier.id);
  const projected = getProblemDossier(dossier.id);
  if (!projected) throw new Error(`Fixture lost dossier ${dossier.id}`);
  return projected;
}

function insertCompletedExposure(input: {
  packetId: string;
  projectId: string;
  observedAt: string;
}): void {
  getSqlite().prepare(`
    INSERT INTO lanes (
      id, project_id, label, repo_path, branch, base_branch, runtime,
      packet_id, status, outcome, ownership, created_at, updated_at,
      last_event_at, last_event_label
    ) VALUES (?, ?, ?, ?, ?, 'main', 'codex', ?, 'completed', 'merged',
      'managed', ?, ?, ?, 'completed')
  `).run(
    `lane-${input.packetId}`,
    input.projectId,
    input.packetId,
    repoPath,
    `agent/${input.packetId}`,
    input.packetId,
    input.observedAt,
    input.observedAt,
    input.observedAt,
  );
}

function insertArchivedExposure(input: {
  packetId: string;
  projectId: string;
  observedAt: string;
  outcome: 'merged' | 'no_changes';
  outcomeNote: string;
}): void {
  getSqlite().prepare(`
    INSERT INTO lanes (
      id, project_id, label, repo_path, branch, base_branch, runtime,
      packet_id, status, outcome, outcome_note, ownership, created_at, updated_at,
      last_event_at, last_event_label
    ) VALUES (?, ?, ?, ?, ?, 'main', 'codex', ?, 'archived', ?, ?,
      'managed', ?, ?, ?, 'archived')
  `).run(
    `lane-${input.packetId}`,
    input.projectId,
    input.packetId,
    repoPath,
    `agent/${input.packetId}`,
    input.packetId,
    input.outcome,
    input.outcomeNote,
    input.observedAt,
    input.observedAt,
    input.observedAt,
  );
}

function mcpText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '{}';
}

describe('problem dossier remedy lifecycle', () => {
  it('projects persisted dossier truth through the authenticated production route', async () => {
    await resetFixture();
    const dossier = createDossier('route visible failure', 'pkt-route');
    const getResponse = await problemDossierRoute.GET(new NextRequest(
      'http://localhost/api/panel/problem-dossiers?includeSuppressed=true',
      { headers: { host: '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' } },
    ));
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      schema: 'o8/problem-dossiers/v1',
      dossiers: [{ id: dossier.id, status: 'candidate', remedies: [] }],
      summary: { total: 1, actionable: 1 },
      metrics: { schema: 'o8/problem-metrics/v1', population: { dossiers: 1 } },
    });

    const anonymousMutation = await problemDossierRoute.POST(new NextRequest(
      'http://localhost/api/panel/problem-dossiers',
      {
        method: 'POST',
        headers: { host: '127.0.0.1', 'Content-Type': 'application/json', 'x-o8-client-addr': '127.0.0.1' },
        body: JSON.stringify({
          action: 'suppress',
          dossierId: dossier.id,
          cooldownDays: 7,
          clientMutationId: 'problem-route-anonymous',
        }),
      },
    ));
    expect(anonymousMutation.status).toBe(403);

    const suppressResponse = await problemDossierRoute.POST(new NextRequest(
      'http://localhost/api/panel/problem-dossiers',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          'Content-Type': 'application/json',
          'x-o8-client-addr': '127.0.0.1',
          authorization: operatorAuthorization,
        },
        body: JSON.stringify({
          action: 'suppress',
          dossierId: dossier.id,
          cooldownDays: 7,
          clientMutationId: 'problem-route-suppress',
        }),
      },
    ));
    expect(suppressResponse.status).toBe(200);
    await expect(suppressResponse.json()).resolves.toMatchObject({
      ok: true,
      dossier: { id: dossier.id, status: 'suppressed' },
    });
    const replayResponse = await problemDossierRoute.POST(new NextRequest(
      'http://localhost/api/panel/problem-dossiers',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          'Content-Type': 'application/json',
          'x-o8-client-addr': '127.0.0.1',
          authorization: operatorAuthorization,
        },
        body: JSON.stringify({
          action: 'suppress',
          dossierId: dossier.id,
          cooldownDays: 7,
          clientMutationId: 'problem-route-suppress',
        }),
      },
    ));
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      clientMutationId: 'problem-route-suppress',
    });
    expect(getProblemDossier(dossier.id)?.history.filter((event) => event.eventType === 'suppressed'))
      .toHaveLength(1);
    const conflictResponse = await problemDossierRoute.POST(new NextRequest(
      'http://localhost/api/panel/problem-dossiers',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          'Content-Type': 'application/json',
          'x-o8-client-addr': '127.0.0.1',
          authorization: operatorAuthorization,
        },
        body: JSON.stringify({
          action: 'resume',
          dossierId: dossier.id,
          clientMutationId: 'problem-route-suppress',
        }),
      },
    ));
    expect(conflictResponse.status).toBe(409);
    expect(getProblemDossier(dossier.id)?.status).toBe('suppressed');

    const listResult = await handleProblemList({ includeSuppressed: true });
    expect(JSON.parse(mcpText(listResult))).toMatchObject({
      schema: 'o8/problem-dossiers/v1',
      dossiers: [{ id: dossier.id, status: 'suppressed' }],
      metrics: { schema: 'o8/problem-metrics/v1', population: { dossiers: 1 } },
    });
    const getResult = await handleProblemGet({ dossierId: dossier.id });
    const mcpDossier = JSON.parse(mcpText(getResult)) as { id: string; evidence: Array<{ packetId: string }> };
    expect(mcpDossier.id).toBe(dossier.id);
    expect(mcpDossier.evidence.map((evidence) => evidence.packetId)).toContain('pkt-route-a');
  });

  it('creates exactly one ordinary task under concurrent acceptance and verifies closure only after clean exposure', async () => {
    await resetFixture();
    const dossier = createDossier('stable type failure', 'pkt-stable');

    const [first, second] = await Promise.all([
      acceptProblemDossier(dossier.id),
      acceptProblemDossier(dossier.id),
    ]);
    expect(first.dossier.linkedTaskId).toBeTruthy();
    expect(second.dossier.linkedTaskId).toBe(first.dossier.linkedTaskId);
    expect(first.dossier.history.map((event) => event.eventType)).toContain('remedy_accepted');
    expect(getProblemDossier(dossier.id)?.history.filter((event) => event.eventType === 'remedy_accepted'))
      .toHaveLength(1);
    expect(listProblemRemedies(dossier.id)).toHaveLength(1);

    const pool = await getTaskPool({ includeDone: true });
    const tasks = pool.tasks.filter((task) => task.problemDossierId === dossier.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: first.dossier.linkedTaskId,
      problemRemedyId: first.remedies[0]?.id,
    });

    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === first.dossier.linkedTaskId);
      if (!packet) throw new Error('Accepted remedy task was not persisted.');
      packet.status = 'released';
      packet.releaseState = 'released';
      packet.lastEventAt = new Date().toISOString();
      packet.lastEventLabel = 'merged';
      packet.releaseStatePayload = {
        mergeCommit: 'merge-remedy-sha',
        releasedAt: packet.lastEventAt,
        // `approve_and_merge` is what the real merge path emits. A release
        // claim whose source is not one hasCanonicalReleaseEvidence accepts is
        // revoked by clearUnprovenReleaseClaim, so the packet reverted to
        // `pending` and the dossier never reached provisionally_resolved.
        source: 'approve_and_merge',
      };
      state.updatedAt = packet.lastEventAt;
    });
    getSqlite().prepare(`
      INSERT INTO lanes (
        id, project_id, label, repo_path, branch, base_branch, runtime,
        packet_id, status, outcome, ownership, created_at, updated_at,
        last_event_at, last_event_label
      ) VALUES ('lane-remedy', ?, 'Remedy', ?, 'agent/remedy', 'main', 'codex',
        ?, 'archived', 'merged', 'managed', ?, ?, ?, 'merged')
    `).run(
      dossier.projectId,
      repoPath,
      first.dossier.linkedTaskId,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await reconcileProblemDossiers();
    expect(getProblemDossier(dossier.id)).toMatchObject({
      status: 'investigating',
      provisionalResolvedAt: null,
      verifiedClosedAt: null,
    });

    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === first.dossier.linkedTaskId);
      if (!packet) throw new Error('Accepted remedy task was not persisted.');
      const reviewedAt = packet.lastEventAt ?? new Date().toISOString();
      packet.review = {
        approved: true,
        findings: [],
        recordedAt: reviewedAt,
        reviewedHeadSha: 'reviewed-remedy-sha',
        summary: 'Remedy reviewed and approved.',
        auditApprovalId: 'approval-remedy',
      };
      state.updatedAt = reviewedAt;
    });
    await reconcileProblemDossiers();
    const provisional = listProblemDossiers({ includeSuppressed: true })[0];
    expect(provisional?.status).toBe('provisionally_resolved');
    expect(provisional?.verifiedClosedAt).toBeNull();
    expect(listProblemRemedies(dossier.id)[0]).toMatchObject({
      taskId: first.dossier.linkedTaskId,
      packetId: first.dossier.linkedTaskId,
      laneId: 'lane-remedy',
      approvalId: 'approval-remedy',
      reviewId: expect.stringContaining(`review:${first.dossier.linkedTaskId}:`),
      releaseRef: 'merge-remedy-sha',
    });

    const exposureBase = Date.now() + 1_000;
    for (let index = 1; index <= 3; index += 1) {
      insertCompletedExposure({
        packetId: `pkt-clean-${index}`,
        projectId: dossier.projectId,
        observedAt: new Date(exposureBase + index * 1_000).toISOString(),
      });
    }
    await reconcileProblemDossiers();
    const closed = listProblemDossiers({ includeSuppressed: true })[0];
    expect(closed).toMatchObject({
      status: 'verified_closed',
      comparableExposureCount: 3,
    });
    expect(closed?.recurrenceProposalId).toBeTruthy();
    expect(closed?.history.map((event) => event.eventType)).toContain('verified_closed');

    enqueueFailure('pkt-stable-d', 'stable type failure');
    const reopened = listProblemDossiers({ includeSuppressed: true })[0];
    expect(reopened).toMatchObject({
      id: dossier.id,
      status: 'reopened',
      occurrenceCount: 4,
      comparableExposureCount: 0,
    });
    expect(reopened?.history.map((event) => event.eventType)).toContain('recurrence_reopened');
    expect(listProblemRemedies(dossier.id)).toHaveLength(1);

    const nextRemedy = await acceptProblemDossier(dossier.id);
    expect(nextRemedy.dossier).toMatchObject({
      status: 'accepted',
      provisionalResolvedAt: null,
      verifiedClosedAt: null,
    });
    expect(nextRemedy.dossier.linkedTaskId).not.toBe(first.dossier.linkedTaskId);
    expect(listProblemRemedies(dossier.id)).toHaveLength(2);
  });

  it('counts only archived lanes with recorded endings for a missing-ending dossier', async () => {
    await resetFixture();
    for (const packetId of ['pkt-ending-a', 'pkt-ending-b', 'pkt-ending-c']) {
      enqueueMissingEnding(packetId);
    }
    const dossier = listProblemDossiers({ includeSuppressed: true })[0];
    if (!dossier) throw new Error('Missing-ending fixture did not create a dossier.');
    const provisionalMs = Date.now() + 1_000;
    const provisionalAt = new Date(provisionalMs).toISOString();
    getSqlite().prepare(`
      UPDATE problem_dossiers
      SET status = 'provisionally_resolved', provisional_resolved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(provisionalAt, provisionalAt, dossier.id);

    insertArchivedExposure({
      packetId: 'pkt-ending-still-broken',
      projectId: dossier.projectId,
      observedAt: new Date(provisionalMs + 1_000).toISOString(),
      outcome: 'no_changes',
      outcomeNote: 'Archived without a recorded ending',
    });
    for (const [index, outcome] of ['merged', 'no_changes', 'merged'].entries()) {
      insertArchivedExposure({
        packetId: `pkt-ending-clean-${index}`,
        projectId: dossier.projectId,
        observedAt: new Date(provisionalMs + (index + 2) * 1_000).toISOString(),
        outcome: outcome as 'merged' | 'no_changes',
        outcomeNote: outcome === 'no_changes' ? 'Agent finished without making changes' : 'Merged cleanly',
      });
    }

    await reconcileProblemDossiers({ now: new Date(provisionalMs + 10_000) });
    expect(getProblemDossier(dossier.id)).toMatchObject({
      status: 'verified_closed',
      comparableExposureCount: 3,
    });
  });

  it('starts a fresh remedy cycle when evidence arrives after release but before closure reconciliation', async () => {
    await resetFixture();
    const dossier = createDossier('late recurrence fixture', 'pkt-late');
    const first = await acceptProblemDossier(dossier.id);
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === first.dossier.linkedTaskId);
      if (!packet) throw new Error('Accepted remedy task was not persisted.');
      packet.status = 'released';
      packet.releaseState = 'released';
      packet.lastEventAt = '2025-01-01T00:00:00.000Z';
      packet.releaseStatePayload = {
        mergeCommit: 'late-recurrence-release',
        releasedAt: packet.lastEventAt,
        // `approve_and_merge` is what the real merge path emits. A release
        // claim whose source is not one hasCanonicalReleaseEvidence accepts is
        // revoked by clearUnprovenReleaseClaim, so the packet reverted to
        // `pending` and the dossier never reached provisionally_resolved.
        source: 'approve_and_merge',
      };
      packet.review = {
        approved: true,
        findings: [],
        recordedAt: packet.lastEventAt,
        reviewedHeadSha: 'late-recurrence-head',
        summary: 'Approved before the recurrence arrived.',
        auditApprovalId: 'approval-late-recurrence',
      };
      state.updatedAt = packet.lastEventAt;
    });

    enqueueFailure('pkt-late-d', 'late recurrence fixture');
    await reconcileProblemDossiers();
    expect(getProblemDossier(dossier.id)).toMatchObject({
      status: 'reopened',
      provisionalResolvedAt: null,
      comparableExposureCount: 0,
    });
    expect(listProblemRemedies(dossier.id)[0]?.status).toBe('recurred');

    const second = await acceptProblemDossier(dossier.id);
    expect(second.dossier.linkedTaskId).not.toBe(first.dossier.linkedTaskId);
    expect(second.remedies).toHaveLength(2);
  });

  it('suppresses without losing evidence, resumes after cooldown, and honors permanent Stop', async () => {
    await resetFixture();
    const dossier = createDossier('cooldown failure', 'pkt-cooldown');
    const suppressed = suppressProblemDossier(dossier.id, {
      now: new Date('2026-08-13T10:00:00.000Z'),
      cooldownDays: 7,
      reason: 'Known maintenance window.',
    });
    expect(suppressed.dossier.status).toBe('suppressed');

    enqueueFailure('pkt-cooldown-d', 'cooldown failure');
    expect(listProblemDossiers({ includeSuppressed: true })[0]).toMatchObject({
      id: dossier.id,
      status: 'suppressed',
      occurrenceCount: 4,
    });

    await reconcileProblemDossiers({ now: new Date('2026-08-21T10:00:00.000Z') });
    expect(listProblemDossiers({ includeSuppressed: true })[0]?.status).toBe('candidate');

    const accepted = await acceptProblemDossier(dossier.id);
    const linkedTaskId = accepted.dossier.linkedTaskId;
    expect(linkedTaskId).toBeTruthy();
    const stopped = await stopProblemDossier(dossier.id, { reason: 'Operator stop.' });
    expect(stopped).toMatchObject({ ok: true, dossier: { status: 'suppressed' } });
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === linkedTaskId);
      expect(packet).toMatchObject({
        queueState: 'held',
        operatorStopped: true,
      });
    });
    await expect(acceptProblemDossier(dossier.id)).rejects.toThrow('operator-stopped');
    enqueueFailure('pkt-cooldown-e', 'cooldown failure');
    expect(listProblemDossiers({ includeSuppressed: true })[0]).toMatchObject({
      status: 'suppressed',
      occurrenceCount: 5,
    });

    const resumed = resumeProblemDossier(dossier.id);
    expect(resumed.dossier).toMatchObject({ status: 'reopened', operatorStoppedAt: null });
  });

  it('keeps Stop absolute when it races acceptance during ordinary task creation', async () => {
    await resetFixture();
    const dossier = createDossier('accept stop race fixture', 'pkt-accept-stop');
    await Promise.allSettled([
      acceptProblemDossier(dossier.id),
      stopProblemDossier(dossier.id, { reason: 'Concurrent operator stop.' }),
    ]);

    expect(getProblemDossier(dossier.id)).toMatchObject({
      status: 'suppressed',
      operatorStoppedAt: expect.any(String),
    });
    const pool = await getTaskPool({ includeDone: true });
    const tasks = pool.tasks.filter((task) => task.problemDossierId === dossier.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ queueState: 'held' });
    await expect(acceptProblemDossier(dossier.id)).rejects.toThrow('operator-stopped');
  });

  it('keeps a failed remedy open for investigation instead of manufacturing closure', async () => {
    await resetFixture();
    const dossier = createDossier('remedy failure fixture', 'pkt-remedy-failure');
    const accepted = await acceptProblemDossier(dossier.id);
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === accepted.dossier.linkedTaskId);
      if (!packet) throw new Error('Accepted remedy task was not persisted.');
      packet.status = 'failed';
      packet.queueState = 'held';
      packet.blockedReason = 'Required real-path verification failed.';
      packet.lastEventAt = new Date().toISOString();
      packet.lastEventLabel = 'verification_failed';
      state.updatedAt = packet.lastEventAt;
    });

    await reconcileProblemDossiers();
    expect(getProblemDossier(dossier.id)).toMatchObject({
      status: 'investigating',
      provisionalResolvedAt: null,
      verifiedClosedAt: null,
      lastError: 'Required real-path verification failed.',
    });
    expect(listProblemRemedies(dossier.id)[0]?.status).toBe('failed');
  });

  it('resolves the linked remedy from a persisted non-current mission after handoff', async () => {
    await resetFixture();
    const dossier = createDossier('mission handoff fixture', 'pkt-handoff');
    const accepted = await acceptProblemDossier(dossier.id);
    let outgoing: Parameters<typeof recordOutgoingMissionSnapshot>[0] | null = null;
    await withLockedState((state) => {
      outgoing = structuredClone(state);
    });
    if (!outgoing) throw new Error('Outgoing mission snapshot was not captured.');
    recordOutgoingMissionSnapshot(outgoing);
    await withLockedState((state) => {
      state.missionId = 'problem-test-new-current';
      state.packets = [];
      state.updatedAt = new Date().toISOString();
    });

    await reconcileProblemDossiers();
    expect(listProblemRemedies(dossier.id)[0]).toMatchObject({
      taskId: accepted.dossier.linkedTaskId,
      packetId: accepted.dossier.linkedTaskId,
      missionId: expect.stringMatching(/^problem-test-/),
      status: 'active',
    });
  });

  it('reopens the same persisted dossier after the database process singleton restarts', async () => {
    await resetFixture();
    const dossier = createDossier('restart persistence fixture', 'pkt-restart');
    closeDb();

    expect(getProblemDossier(dossier.id)).toMatchObject({
      id: dossier.id,
      fingerprint: dossier.fingerprint,
      occurrenceCount: 3,
      evidence: expect.arrayContaining([
        expect.objectContaining({ packetId: 'pkt-restart-a' }),
      ]),
    });
  });
});
