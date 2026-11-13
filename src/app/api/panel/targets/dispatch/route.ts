import { readJsonObject } from '@/lib/panel/read-json-object';
export const dynamic = 'force-dynamic';

import { MissionProjectScopeError } from '@/lib/orchestrator/mission-project-context';
import { NextResponse } from 'next/server';
import { homedir } from 'node:os';

import { getScores } from '@/lib/targeting/store';
import { resolveTargetingRouting } from '@/lib/targeting/routing';
import { logDispatchChoice } from '@/lib/targeting/observability';
import { createMission, dispatchMission } from '@/lib/orchestrator/operator-mission-service';
import type { CreateMissionInput } from '@/lib/orchestrator/operator-mission-service';
import { nextInlineIssueNumbers } from '@/lib/orchestrator/operator-mission-service/shared';
import { findMissionByCreationMutationId } from '@/lib/orchestrator/create-mission-receipt';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';

/**
 * Point an agent at a targeted file. Resolves the file's dispatch routing (cheap
 * triage vs premium action tier → runtime/model, step 6), then creates + fires a
 * mission with those requestedRuntime/requestedModel — which flow through
 * `resolveWorkerRouting` unchanged. Gated under /api/panel/* (loopback + token).
 * No throw — structured errors.
 */
export async function POST(request: Request) {
  const body = await readJsonObject<{ repoPath?: string; projectId?: string; path?: string; clientMutationId?: string }>(request);
  if (!body) {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (body.projectId !== undefined && (typeof body.projectId !== 'string' || !body.projectId.trim())) {
    return NextResponse.json({ ok: false, error: 'projectId must be a non-empty project identifier' }, { status: 400 });
  }
  const rawRepo = (body.repoPath || process.cwd()).trim();
  const repoPath = rawRepo.startsWith('~') ? rawRepo.replace('~', homedir()) : rawRepo;
  const filePath = (body.path || '').trim();
  const clientMutationId = body.clientMutationId?.trim();
  if (!filePath) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (!clientMutationId) return NextResponse.json({ ok: false, error: 'clientMutationId is required' }, { status: 400 });

  // Server-authoritative signals: read the cached score row (the triage GET just
  // wrote it). Avoids trusting client-supplied signals for the routing decision.
  const score = getScores(repoPath).find((s) => s.path === filePath);
  if (!score) {
    return NextResponse.json(
      { ok: false, error: 'no cached score for that file — run the triage (GET /api/panel/targets) first.' },
      { status: 409 },
    );
  }

  const routing = resolveTargetingRouting(score.signals, { repoPath, contextId: filePath });

  try {
    const [issueNumber] = nextInlineIssueNumbers(1);
    const brief = [
      `Operator-directed target from the Targeting Machine (impact ${score.impact}/5, opportunity ${score.opportunity}/5).`,
      `Why here: ${score.rationale}`,
      '',
      `Review and improve \`${filePath}\`. Keep the change surgical and well-scoped; open a reviewable diff.`,
    ].join('\n');

    const createInput: CreateMissionInput = {
      issues: [{ number: issueNumber!, title: `Targeting: ${filePath}`, body: brief, url: '' }],
      repoPath,
      ...(body.projectId ? { projectId: body.projectId.trim() } : {}),
      runtime: routing.runtime,
      requestedRuntime: routing.runtime,
      requestedModel: routing.model || null,
      // Close the loop: the tier's effort now reaches the worker launch (cheap
      // triage → low, premium action → high). A no-op for gemini/opencode tiers.
      requestedEffort: routing.effort,
      constraints: '',
      // Target dispatch is an immediate operation; retain scheduler admission
      // until its synchronous dispatch binds the packet to a lane.
      dispatchOnCreate: true,
      workerIntent: routing.tier === 'triage' ? 'light_worker' : 'heavy_worker',
    };
    const canonicalBody = JSON.stringify({ repoPath, filePath, score: score.score, createInput });
    const binding = bindIdempotencyClientMutation({
      namespace: 'target_dispatch',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json({ ok: false, error: 'clientMutationId was used for another target dispatch' }, { status: 409 });
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({ ok: false, error: 'The target dispatch receipt store is unavailable' }, { status: 503 });
    }
    const creationMutationId = `${clientMutationId}:mission`;
    const finish = async (mission: Awaited<ReturnType<typeof createMission>>) => {
      const dispatch = await dispatchMission({ missionId: mission.missionId });
      return { ok: true as const, missionId: mission.missionId, dispatch };
    };
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'target_dispatch', scopeId: filePath, clientKey: clientMutationId, body: canonicalBody }),
      verb: 'target_dispatch',
      scopeId: filePath,
      reconcileUnresolved: async () => {
        const state = findMissionByCreationMutationId(creationMutationId);
        return state?.creationReceipt ? finish(state.creationReceipt) : null;
      },
    }, async () => finish(await createMission({ ...createInput, clientMutationId: creationMutationId })));
    if (outcome.inProgress) {
      if (outcome.unresolved) {
        return NextResponse.json({ ok: false, outcomeUnknown: true, error: 'The prior target dispatch outcome cannot be reconstructed. Inspect missions and lanes before taking another action.' }, { status: 409 });
      }
      return NextResponse.json({ ok: true, inProgress: true, status: 'in_progress' }, { status: 202 });
    }
    const missionId = outcome.result.missionId;

    // Observability seed for the future recalibration loop — the operator's
    // ground-truth choice (which file, at what score/tier).
    logDispatchChoice({
      repoPath, path: filePath, missionId,
      tier: routing.tier, runtime: routing.runtime, model: routing.model || null, effort: routing.effort,
      impact: score.impact, opportunity: score.opportunity, score: score.score,
    });

    return NextResponse.json({
      ok: true,
      missionId,
      replayed: outcome.replayed || undefined,
      path: filePath,
      tier: routing.tier,
      runtime: routing.runtime,
      model: routing.model || null,
      effort: routing.effort,
    });
  } catch (err) {
    if (err instanceof MissionProjectScopeError) {
      return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'dispatch failed' },
      { status: 500 },
    );
  }
}
