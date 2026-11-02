import { findPrRepairOwner, PrRepairOwnerError, repairPacketStillOwned, samePrRepairRepo } from '@/lib/orchestrator/pr-repair-owner';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { withWsHealthHandler } from '@/lib/ws-server/handler-activity';
import { resolveReviewerPrSource, reviewerCreationBase, ReviewerPrSourceError, ReviewerPrInputError, validateReviewPullRequest, validateRepairPullRequest, StaleRepairHeadError } from '@/lib/orchestrator/reviewer-pr-source';
import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@/lib/lane/commands';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { createHash } from 'node:crypto';
import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { computeReadBudget, resolveModelTier } from '@/lib/dispatch/read-budget';
import { computePredictedFiles } from '@/lib/orchestrator/preservation-envelope';
import { codename } from '@/lib/agents/codename';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveWorkerHuddle } from '@/lib/operator/worker-start-mode';
import { buildProjectTaskBrief, getProjectContext } from '@/lib/projects/context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listLanes } from '@/lib/lane/registry';
import { launchSharedCheckoutWorker } from '@/lib/orchestrator/shared-checkout-launch';
import { findSharedCheckoutMemberByMutation, readSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { DelegationSelectionError, resolveDelegationSelection } from '@/lib/orchestrator/delegation-selection';
import { resolveEffortAliases } from '@/lib/orchestrator/effort-pin';
import { getWorkerCatalog, WorkerCatalogReadError, WorkerCatalogSelectionError } from '@/lib/orchestrator/worker-catalog';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { requirePanelAuth } from '@/lib/panel/auth';
import { authorizeFastDelegation } from '@/lib/orchestrator/fast-delegation-auth';
import {
  buildPacketCompletionInstructions,
} from '@/lib/orchestrator/self-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/delegate
 *
 * Orchestrator delegation endpoint — creates a packet shell, opens a lane
 * linked to that packet, and launches a Codex session in one step. Every
 * delegated lane gets a real packetId so approve_and_merge, cortex_steer_agent,
 * reset_packet, and the whole governance toolchain work on it without the
 * orchestrator having to fall back to raw git commands.
 *
 * Body: { prompt, repoPath, taskName?, isolate?, baseBranch? }
 *   baseBranch — the branch the new lane should fork from (default: 'main').
 *     Used by fix dispatches that need to resume work against a feature
 *     branch whose diff exists only on that branch. See #530 Option A.
 * Returns: { ok, laneId, packetId, surfaceId, worktreePath, note, approvalId?, baseBranch }
 *
 * Note on #530 follow-ups: Options B (dedicated `resume` verb for
 * existing lanes) and C (fix `cortex_steer_agent` at its root) are
 * deferred — track them in a follow-up issue. Option A ships here as
 * the quickest unlock for medium (5–50-edit) fix dispatches.
 */
async function performDelegate(request: NextRequest, clientMutationId: string) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const prompt = (body.prompt as string)?.trim();
  const repoPath = (body.repoPath as string)?.trim();
  const taskName = (body.taskName as string)?.trim() || prompt?.slice(0, 60);
  const isolate = body.isolate !== false; // Default true for delegated work
  const readOnly = body.readOnly === true;
  const checkoutMode = body.checkoutMode === 'shared' ? 'shared' : 'isolated';
  const parentThreadId = typeof body.parentThreadId === 'string' ? body.parentThreadId.trim() : '';
  const assignedPaths = Array.isArray(body.assignedPaths)
    ? body.assignedPaths.filter((path): path is string => typeof path === 'string')
    : [];

  // #530 — Option A. Caller may override the base branch so a fix dispatch
  // forks off a feature branch instead of main. Absent / blank → 'main' so
  // existing callers behave identically.
  const baseBranchRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
  const baseBranch = baseBranchRaw || 'main';

  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required' }, { status: 400 });
  }
  if (!isolate && checkoutMode !== 'shared') {
    return NextResponse.json({ ok: false, error: 'Shared checkout dispatch requires Shared mode and a parent orchestrator chat.' }, { status: 400 });
  }
  // Generate a branch name from the task
  const slug = taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(`${prompt}-${clientMutationId}`).digest('hex').slice(0, 6);
  // When not isolating we just write directly onto the caller's baseBranch
  // (typically 'main'). When isolating we fork a fresh agent/* branch from
  // baseBranch — the lane command carries baseBranch through to the
  // worktree manager so `git worktree add -b <branch> origin/<baseBranch>`
  // uses the right starting point.
  const branch = isolate ? `agent/${slug}-${hash}` : baseBranch;

  try {
    // Step 1: Synthesize a packet shell in the orchestrator control plane
    // so every downstream governance tool (approve_and_merge, reset_packet,
    // cortex_steer_agent, submit_review) can find this work by packetId.
    // Without this, delegate-dispatched lanes are second-class citizens and
    // force the orchestrator to fall back to raw Bash/git, which is slow
    // and hides state from the UI.
    const packetId = `pkt-delegate-${createHash('sha256').update(clientMutationId).digest('hex').slice(0, 16)}`;
    const now = new Date().toISOString();
    const defaults = getOperatorDefaultsSync().values;
    const { routing: workerRouting, carrier, launchEffort, executionCarrier } = await resolveDelegationSelection(body, repoPath);
    const reviewPullRequest = validateReviewPullRequest(body);
    const reviewSource = reviewPullRequest === undefined ? undefined : await resolveReviewerPrSource({
      repoPath, packetId, pullRequest: reviewPullRequest,
      existing: readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)?.reviewSource,
    });
    const repairPullRequest = validateRepairPullRequest(body);
    if (repairPullRequest !== undefined) {
      const owner = findPrRepairOwner(repoPath, repairPullRequest, packetId);
      if (owner) throw new PrRepairOwnerError(owner.id);
    }
    const repairSource = repairPullRequest === undefined ? undefined : await resolveReviewerPrSource({
      repoPath, packetId, pullRequest: repairPullRequest,
      existing: readOrchestratorControlPlaneState().packets.find(p => p.id === packetId)?.repairSource,
    });
    if (repairSource && repairSource.headSha !== body.expectedRepairHeadSha) throw new StaleRepairHeadError();
    const prSource = reviewSource ?? repairSource;
    const huddle = resolveWorkerHuddle({
      mode: defaults.workerStartMode,
      explicitHuddle: typeof body.huddle === 'boolean' ? body.huddle : undefined,
      profile: defaults.subscriptionProfile,
      runtime: workerRouting.selectedRuntime,
      model: workerRouting.selectedModel,
    });

    // #535 — Compute a read budget at dispatch time so weaker models don't
    // start writing before reading the adjacent surface. The helper returns
    // null when no budget is warranted (empty targets / strong tier w/ no
    // graph), which preserves legacy behaviour for delegate callers.
    const predictedFiles = computePredictedFiles({
      workspaceTargetPath: repoPath,
      title: taskName,
      summary: prompt,
    } as OrchestratorPacket);
    const modelTier = resolveModelTier({
      runtime: workerRouting.selectedRuntime,
      assignedModel: workerRouting.selectedModel,
    });
    const readBudget = computeReadBudget({
      repoPath,
      targetFiles: predictedFiles,
      tier: modelTier,
    }) ?? undefined;

    // #536 — Edge-case surfacer — never throws, returns { sites: [] } on
    // garbage input so the packet shape stays legal.
    const edgeCaseResult = surfaceEdgeCases({
      repoPath,
      targetFiles: predictedFiles,
      depth: 1,
    });
    const edgeCaseSites = edgeCaseResult.sites.length > 0 ? edgeCaseResult.sites : undefined;
    const projectContext = await getProjectContext({ repoPath });
    const projectBrief = buildProjectTaskBrief(projectContext, {
      repoPath,
      taskTitle: taskName,
      taskBody: prompt,
    });
    const launchPrompt = buildProjectBriefPromptV1(projectBrief, prompt);
    if (checkoutMode === 'shared') {
      const shared = await launchSharedCheckoutWorker({
        repoPath,
        parentThreadId,
        prompt: launchPrompt,
        taskName,
        runtime: workerRouting.selectedRuntime,
        model: workerRouting.selectedModel,
        effort: launchEffort,
        carrier,
        executionCarrier,
        workerRouting,
        readOnly,
        clientMutationId,
        repoInProject: projectContext.repoInProject,
        assignedPaths,
      });
      if (!shared.ok) return NextResponse.json(shared, { status: 422 });
      invalidateCommandCenterSnapshotCaches();
      invalidateInboxCache();
      await publishRealtimeMutation({
        mutation: {
          mutationId: `shared-delegate-${shared.surfaceId}-${Date.now()}`,
          source: 'desktop',
          action: 'launch',
          runtime: workerRouting.selectedRuntime,
          repoPath,
          surfaceId: shared.surfaceId,
          sessionKey: shared.surfaceId,
          status: 'queued',
          note: `Shared worker: ${taskName}`,
          launchContext: shared.launchContext,
          createdAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
        refreshTargets: ['global', 'mobileInbox'],
        sessionKeys: [shared.surfaceId],
        fresh: true,
      });
      return NextResponse.json({ ...shared, workerRouting });
    }
    const launchContext = {
      source: 'agent' as const,
      presentation: 'split' as const,
      repoContext: projectContext.repoInProject ? 'registered' as const : 'transient' as const,
      workMode: readOnly ? 'read-only' as const : 'edit' as const,
      caller: 'orchestrator',
      ...(executionCarrier ? { executionCarrier } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      checkoutMode: 'isolated' as const,
    };

    const packet: OrchestratorPacket = {
      id: packetId,
      ...(executionCarrier ? { executionCarrier } : {}),
      ...(parentThreadId ? { orchestratorThreadId: parentThreadId } : {}),
      ...(carrier ? { claudeCodeCarrier: carrier, claudeCodeModel: workerRouting.selectedModel } : {}),
      referenceLabel: `D${Date.now().toString(36).slice(-4).toUpperCase()}`,
      title: taskName,
      summary: prompt,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: workerRouting.selectedRuntime,
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      attemptCount: 1,
      maxAttempts: 3,
      blockedReason: null,
      lastEventAt: now,
      lastEventLabel: 'delegate_dispatched',
      archivedAt: null,
      review: null,
      lane: null,
      assignedModel: workerRouting.selectedModel,
      predictedFiles: predictedFiles.length > 0 ? predictedFiles : undefined,
      readBudget,
      edgeCaseSites,
      workerIntent: workerRouting.workerIntent,
      workerRouting,
      huddle,
      prompt: launchPrompt,
      ...(reviewSource ? { reviewSource } : {}),
      ...(repairSource ? { repairSource } : {}),
      launchContext,
    };

    const completionContract = buildPacketCompletionInstructions(readOnly, repairSource?.headSha ?? baseBranch);
    const governedLaunchPrompt = [launchPrompt, ...(reviewSource ? [`Review PR #${reviewSource.pullRequest} at exact HEAD ${reviewSource.headSha}. Its source is already checked out; do not fetch or switch branches.`] : []), ...(repairSource ? [`Repair PR #${repairSource.pullRequest} at exact starting HEAD ${repairSource.headSha}. Its source is already checked out; do not fetch or switch branches.`] : []), ...completionContract].join('\n\n');

    // Append the packet by MUTATING the state object passed into the
    // withLockedState callback. Critical: do NOT call writeOrchestratorControlPlaneState
    // from inside the callback — withLockedState's post-callback reconcile uses
    // the ORIGINAL `current` reference and writes that, which would clobber any
    // direct write we made ourselves. Mutation is the working pattern because
    // reconcile re-reads the mutated fields from the same object.
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((current) => {
      if (repairSource && current.packets.some(candidate => candidate.id !== packetId && repairPacketStillOwned(candidate, listLanes())
        && candidate.workspaceTargetPath && samePrRepairRepo(candidate.workspaceTargetPath, repoPath) && candidate.repairSource?.pullRequest === repairSource.pullRequest)) throw new PrRepairOwnerError();
      if (!current.packets.some((candidate) => candidate.id === packet.id)) current.packets.push(packet);
      if (!current.missionId) current.missionId = `delegate-${Date.now().toString(36)}`;
      if (!current.prompt) current.prompt = `Delegated work: ${taskName}`;
      if (!current.summary) current.summary = `Delegate dispatches routed through /api/orchestrator/delegate.`;
      if (!current.repoPath) current.repoPath = repoPath;
      if (!current.runtime) current.runtime = workerRouting.selectedRuntime;
      current.updatedAt = now;
    });

    // Step 2: Open a lane bound to the synthesized packet. #530 — pass the
    // resolved baseBranch through so fix dispatches can fork from a feature
    // branch rather than main.
    const laneResult = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch,
      baseBranch,
      runtime: workerRouting.selectedRuntime,
      projectId: projectContext.id,
      label: taskName,
      packetId,
      actor: 'orchestrator',
    }, ...(prSource ? [{ packetCreationBase: reviewerCreationBase({ repoPath, packetId, branch, baseBranch, source: prSource }) }] as const : []));

    if (!laneResult.ok || !laneResult.laneId) {
      // Preserve the failed admission receipt, but do not reserve a PR forever
      // when the registry proves no lane (and therefore no worker) was created.
      if (repairSource && !listLanes().some(lane => lane.packetId === packetId)) {
        await withLockedState(current => {
          const failed = current.packets.find(candidate => candidate.id === packetId);
          if (failed) { failed.status = 'failed'; failed.archivedAt = new Date().toISOString(); failed.lastEventLabel = 'repair_lane_admission_failed'; }
        });
      }
      return NextResponse.json({
        ok: false,
        packetId,
        error: laneResult.note || 'Failed to open lane',
      }, { status: 422 });
    }

    const laneId = laneResult.laneId;

    // Step 3: Launch a session in the lane
    const launchResult = await dispatch({
      verb: 'launch_session',
      laneId,
      prompt: governedLaunchPrompt,
      model: workerRouting.selectedModel ?? undefined,
      effort: launchEffort,
      ...(executionCarrier ? { executionCarrier } : {}),
      ...(carrier ? { claudeCodeCarrier: carrier, claudeCodeModel: workerRouting.selectedModel ?? undefined } : {}),
      clientMutationId,
      launchContext,
      actor: 'orchestrator',
    });

    // If launch requires approval (policy gate), return the approval info
    if (launchResult.approvalId) {
      return NextResponse.json({
        ok: true,
        status: 'pending_approval',
        laneId,
        packetId,
        codename: codename(laneId),
        approvalId: launchResult.approvalId,
        note: launchResult.note,
      }, { status: 200 });
    }

    if (!launchResult.ok) {
      return NextResponse.json({
        ok: false,
        laneId,
        packetId,
        error: launchResult.note || 'Failed to launch session',
      }, { status: 422 });
    }

    // Broadcast the delegation event
    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `delegate-${laneId}-${Date.now()}`,
        source: 'desktop',
        action: 'launch',
        runtime: workerRouting.selectedRuntime,
        surfaceId: launchResult.lane?.sessionKey || laneId,
        sessionKey: launchResult.lane?.sessionKey || laneId,
        status: 'queued',
        note: `Delegated: ${taskName}`,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      sessionKeys: launchResult.lane?.sessionKey ? [launchResult.lane.sessionKey] : [],
      fresh: true,
    });

    return NextResponse.json({
      ok: true,
      laneId,
      packetId,
      // The canvas card labels this lane `codename(laneId)` (deterministic,
      // codename.ts is the single source of truth) — return it so voice
      // surfaces announce the SAME name the operator sees on the card.
      codename: codename(laneId),
      surfaceId: launchResult.lane?.sessionKey || null,
      worktreePath: launchResult.lane?.worktreePath || null,
      branch,
      baseBranch,
      workerRouting,
      reviewSource: reviewSource ?? null,
      repairSource: repairSource ?? null,
      note: launchResult.note,
    });
  } catch (err) {
    if (err instanceof PrRepairOwnerError) return NextResponse.json({ ok: false, code: err.code, ownerLaneId: err.ownerLaneId, error: err.message }, { status: 409 });
    if (err instanceof StaleRepairHeadError) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: 409 });
    if (err instanceof ReviewerPrSourceError) return NextResponse.json({ ok: false, code: 'review_source_unavailable', error: err.message }, { status: 422 });
    if (err instanceof DelegationSelectionError || err instanceof ReviewerPrInputError) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: 400 });
    console.error('[orchestrator-delegate]', err);
    return NextResponse.json({
      ok: false,
      error: 'Delegation failed',
    }, { status: checkoutMode === 'shared' ? 422 : 500 });
  }
}

export function POST(request: NextRequest) {
  return withWsHealthHandler('dispatch', () => postDelegate(request));
}

async function postDelegate(request: NextRequest) {
  const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (body?.repairPullRequest !== undefined && resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ ok: false, error: 'Operator authority is required to start a PR repair.' }, { status: 403 });
  try { if (body) { validateReviewPullRequest(body); validateRepairPullRequest(body); } } catch (error) {
    if (error instanceof DelegationSelectionError || error instanceof ReviewerPrInputError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: false, code: 'invalid_review_pull_request', error: 'Unable to validate the PR review target.' }, { status: 400 });
  }
  if (body?.checkoutMode === 'shared') {
    const authorization = authorizeFastDelegation({
      repoPath: typeof body.repoPath === 'string' ? body.repoPath.trim() : '',
      parentThreadId: typeof body.parentThreadId === 'string' ? body.parentThreadId.trim() : '',
      capability: typeof body.fastCapability === 'string' ? body.fastCapability.trim() : '',
    });
    if (!authorization.ok) {
      return NextResponse.json({ ok: false, error: authorization.error }, { status: authorization.status });
    }
  }
  const clientMutationId = typeof body?.clientMutationId === 'string'
    ? body.clientMutationId.trim()
    : '';
  if (!clientMutationId) {
    return NextResponse.json({ ok: false, error: 'clientMutationId is required' }, { status: 400 });
  }
  // Invalid effort has no launch effect and must not consume the caller's
  // mutation identity. Keep correction possible with the same correlation ID.
  const effortAliases = resolveEffortAliases(body?.requestedEffort, body?.thinkingEffort);
  if (!effortAliases.ok) {
    return NextResponse.json({ ok: false, code: effortAliases.code, error: effortAliases.message }, { status: 400 });
  }
  const canonicalBody = JSON.stringify({
    prompt: typeof body?.prompt === 'string' ? body.prompt.trim() : '',
    repoPath: typeof body?.repoPath === 'string' ? body.repoPath.trim() : '',
    taskName: typeof body?.taskName === 'string' ? body.taskName.trim() : '',
    isolate: body?.isolate !== false,
    checkoutMode: body?.checkoutMode === 'shared' ? 'shared' : 'isolated',
    parentThreadId: typeof body?.parentThreadId === 'string' ? body.parentThreadId.trim() : '',
    assignedPaths: Array.isArray(body?.assignedPaths) ? body.assignedPaths : [],
    baseBranch: typeof body?.baseBranch === 'string' ? body.baseBranch.trim() : '',
    runtime: body?.runtime ?? null,
    model: body?.model ?? null,
    requestedEffort: body?.requestedEffort ?? null,
    thinkingEffort: body?.thinkingEffort ?? null,
    workerIntent: body?.workerIntent ?? null,
    requestedProvider: body?.requestedProvider ?? null,
    huddle: body?.huddle ?? null,
    readOnly: body?.readOnly === true,
    reviewPullRequest: body?.reviewPullRequest ?? null,
    repairPullRequest: body?.repairPullRequest ?? null,
    expectedRepairHeadSha: body?.expectedRepairHeadSha ?? null,
  });
  const binding = bindIdempotencyClientMutation({
    namespace: 'orchestrator_delegate',
    clientKey: clientMutationId,
    body: canonicalBody,
  });
  if (binding.status === 'conflict') {
    return NextResponse.json({ ok: false, error: 'clientMutationId was used for another delegation' }, { status: 409 });
  }
  if (binding.status === 'unavailable') {
    return NextResponse.json({ ok: false, error: 'The delegation receipt store is unavailable' }, { status: 503 });
  }
  const packetId = `pkt-delegate-${createHash('sha256').update(clientMutationId).digest('hex').slice(0, 16)}`;
  const responseReceipt = async () => {
    const response = await performDelegate(new NextRequest(request.clone()), clientMutationId);
    return { status: response.status, payload: await response.json() as Record<string, unknown> };
  };
  const outcome = await withIdempotency({
    key: deriveIdempotencyKey({
      verb: 'orchestrator_delegate',
      scopeId: String(body?.repoPath ?? ''),
      clientKey: clientMutationId,
      body: canonicalBody,
    }),
    verb: 'orchestrator_delegate',
    scopeId: String(body?.repoPath ?? ''),
    reconcileUnresolved: async () => {
      if (body?.checkoutMode === 'shared' && typeof body.repoPath === 'string' && typeof body.parentThreadId === 'string') {
        const teamInput = { repoPath: body.repoPath, parentThreadId: body.parentThreadId };
        const member = findSharedCheckoutMemberByMutation(teamInput, clientMutationId);
        const team = member ? readSharedCheckoutTeam(teamInput) : null;
        if (member?.state === 'failed') return {
          status: 422,
          payload: { ok: false, error: 'The shared worker launch failed; inspect its team receipt before retrying.' },
        };
        if (member?.surfaceId && member.state === 'running' && team) return {
          status: 200,
          payload: {
            ok: true,
            teamId: team.id,
            workerRouting: member.workerRouting ?? null,
            laneId: null,
            packetId: null,
            surfaceId: member.surfaceId,
            worktreePath: team.path,
            branch: team.branch,
            checkoutMode: 'shared',
            launchContext: {
              source: 'agent',
              presentation: 'split',
              repoContext: 'transient',
              workMode: body?.readOnly === true ? 'read-only' : 'edit',
              caller: 'orchestrator',
              parentThreadId: team.parentThreadId,
              checkoutMode: 'shared',
            },
            note: 'Recovered the shared worker from its durable team receipt.',
          },
        };
        return null;
      }
      const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
      const lane = listLanes().find((candidate) => candidate.packetId === packetId && candidate.sessionKey);
      if (!packet || !lane?.sessionKey) return null;
      return {
        status: 200,
        payload: {
          ok: true,
          laneId: lane.id,
          packetId,
          codename: codename(lane.id),
          surfaceId: lane.sessionKey,
          worktreePath: lane.worktreePath,
          branch: lane.branch,
          baseBranch: lane.baseBranch,
          workerRouting: packet.workerRouting ?? null,
          reviewSource: packet.reviewSource ?? null,
          repairSource: packet.repairSource ?? null,
          launchContext: packet.launchContext,
          note: 'Recovered the delegated worker from its durable packet and lane binding.',
        },
      };
    },
  }, responseReceipt);
  if (outcome.inProgress) {
    if (outcome.unresolved) {
      return NextResponse.json({
        ok: false,
        error: 'outcome_unknown',
        outcomeUnknown: true,
        note: 'The prior delegated launch process ended before its receipt was persisted. The outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect the packet and lane before taking another action.',
      }, { status: 409 });
    }
    return NextResponse.json({ ok: true, inProgress: true, status: 'in_progress' }, { status: 202 });
  }
  return NextResponse.json({
    ...outcome.result.payload,
    replayed: outcome.replayed || undefined,
  }, { status: outcome.result.status });
}

/** Authenticated, read-only worker discovery. No provider turn or settings mutation. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const runtime = request.nextUrl.searchParams.get('runtime');
  if (runtime && !isOrchestratorRuntime(runtime)) return NextResponse.json({ ok: false, error: 'Unknown worker runtime.' }, { status: 400 });
  try {
    return NextResponse.json(await getWorkerCatalog(request.nextUrl.searchParams.get('repoPath') || process.cwd(), runtime && isOrchestratorRuntime(runtime) ? runtime : undefined), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof WorkerCatalogSelectionError ? 400 : 503;
    return NextResponse.json({ ok: false,
      error: error instanceof Error ? error.message : 'Worker catalog unavailable.',
      call: 'GET /api/orchestrator/delegate',
      step: error instanceof WorkerCatalogReadError ? error.call : 'getWorkerCatalog',
      status, retryable: status === 503,
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
