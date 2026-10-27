import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import {
  launchRuntimeSurface,
  type RuntimeLaunchRequest,
  type RuntimeLaunchResult,
} from '@/lib/runtime/actions';
import { RuntimeLaunchPostEffectError } from '@/lib/runtime/launch-governance';
import { listLanes } from '@/lib/lane/registry';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';
import { isClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { normalizePacketSpendCap } from '@/lib/orchestrator/metered-spend';
import { assertSingleAttemptLaunch } from '@/lib/runtime/single-attempt-launch';
import { EFFORT_CHOICE_LIST, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { resolveDefaultDispatchModelSync } from '@/lib/operator/defaults';
import { getSelectedRuntimeIdentity } from '@/lib/runtime/identity-catalog';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function canonicalLaunchRequest(
  payload: RuntimeLaunchRequest,
  runtimeName: string,
  clientMutationId: string,
): RuntimeLaunchRequest {
  return {
    automaticRecoverySurfaceId: payload.automaticRecoverySurfaceId,
    automaticRecoveryRunId: payload.automaticRecoveryRunId,
    executionPolicy: payload.executionPolicy,
    runtime: runtimeName as RuntimeLaunchRequest['runtime'],
    prompt: payload.prompt?.trim() ?? '',
    model: trimmed(payload.model),
    claudeCodeModel: trimmed(payload.claudeCodeModel),
    claudeCodeCarrier: payload.claudeCodeCarrier,
    effort: payload.effort,
    workMode: payload.workMode,
    spendCap: normalizePacketSpendCap(payload.spendCap),
    clientMutationId,
    cwd: payload.cwd?.trim() ?? '',
    repoPath: trimmed(payload.repoPath),
    projectRepoPath: trimmed(payload.projectRepoPath),
    taskName: trimmed(payload.taskName),
    branchName: trimmed(payload.branchName),
    baseBranch: trimmed(payload.baseBranch),
    isolate: payload.isolate
      ?? (payload.isolation === 'branch' ? true : payload.isolation === 'main' ? false : undefined),
    skipSetup: payload.skipSetup,
    existingLaneId: trimmed(payload.existingLaneId),
    packetId: trimmed(payload.packetId),
  };
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as RuntimeLaunchRequest | null;
  const runtimeName = payload?.runtime?.trim();
  const clientMutationId = payload?.clientMutationId?.trim();

  if (!runtimeName) {
    return NextResponse.json({ error: 'runtime is required for this launch route' }, { status: 400 });
  }
  if (!payload || !clientMutationId) {
    return NextResponse.json({ error: 'clientMutationId is required for this launch route' }, { status: 400 });
  }
  const sourceRefusal = knowledgeSourceWriteRefusal(payload.cwd, payload.repoPath, payload.projectRepoPath);
  if (sourceRefusal) return sourceRefusal;
  if (payload.effort !== undefined && !isThinkingEffort(payload.effort)) {
    return NextResponse.json({
      error: `effort must be one of: ${EFFORT_CHOICE_LIST}.`, code: 'invalid_effort',
    }, { status: 400 });
  }
  if ((payload.claudeCodeModel !== undefined && typeof payload.claudeCodeModel !== 'string')
    || (payload.executionPolicy !== undefined && payload.executionPolicy !== 'single-attempt')
    || (payload.claudeCodeCarrier !== undefined && !isClaudeCodeModelSource(payload.claudeCodeCarrier))
    || (payload.workMode !== undefined && payload.workMode !== 'edit' && payload.workMode !== 'read-only')
    || (payload.spendCap !== undefined && !normalizePacketSpendCap(payload.spendCap))) {
    return NextResponse.json({ error: 'Invalid carrier, work mode, or spend cap for this launch.' }, { status: 400 });
  }

  if ((payload.automaticRecoverySurfaceId !== undefined || payload.automaticRecoveryRunId !== undefined)
    && (typeof payload.automaticRecoverySurfaceId !== 'string' || !payload.automaticRecoverySurfaceId.startsWith(`${runtimeName}-owned:`)
      || typeof payload.automaticRecoveryRunId !== 'string' || !payload.automaticRecoveryRunId.trim())) {
    return NextResponse.json({ error: 'Automatic retry requires the original owned runtime and generation.' }, { status: 400 });
  }

  const launchRequest = canonicalLaunchRequest(payload, runtimeName, clientMutationId);
  // A concrete pin must survive the adapter's mapping. Validate before the
  // receipt binding so a rejected selection can be corrected with the same ID.
  if (launchRequest.effort && launchRequest.effort !== 'adaptive') {
    const effortPin = resolveEffortPin({
      requestedEffort: launchRequest.effort,
      runtime: runtimeName,
      model: launchRequest.model
        ?? (runtimeName === 'codex' ? resolveDefaultDispatchModelSync() || null : null),
      codexHome: runtimeName === 'codex' && (launchRequest.effort === 'none' || launchRequest.effort === 'minimal')
        ? (await getSelectedRuntimeIdentity('codex'))?.configHomeRef
        : undefined,
    });
    if (!effortPin.ok) {
      return NextResponse.json({ error: effortPin.message, code: effortPin.code }, { status: 400 });
    }
  }
  try { assertSingleAttemptLaunch({ ...launchRequest, executionCarrier: payload.executionCarrier }, launchRequest.workMode); }
  catch { return NextResponse.json({ error: 'Single-attempt workers require exact native runtime, model, effort and read-only pins.' }, { status: 400 }); }
  const canonicalBody = JSON.stringify(launchRequest);

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'runtime_launch',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json(
        { error: 'clientMutationId was already used for a different runtime launch.' },
        { status: 409 },
      );
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json(
        { error: 'The persisted idempotency store is unavailable; the runtime was not launched.' },
        { status: 503 },
      );
    }

    const scopeId = launchRequest.existingLaneId
      ?? launchRequest.packetId
      ?? launchRequest.repoPath
      ?? launchRequest.cwd
      ?? runtimeName;
    const outcome = await withIdempotency<RuntimeLaunchResult>(
      {
        key: deriveIdempotencyKey({
          verb: 'runtime_launch',
          scopeId,
          clientKey: clientMutationId,
          body: canonicalBody,
        }),
        verb: 'runtime_launch',
        scopeId,
        reconcileUnresolved: async () => {
          const owned = await findOwnedLaunchByMutationId(clientMutationId);
          if (!owned) return null;
          const lane = listLanes().find((candidate) => candidate.sessionKey === owned.surfaceId);
          const expectedGovernance = Boolean(
            launchRequest.existingLaneId
            || launchRequest.isolate
            || (
              launchRequest.repoPath
              && owned.repoPath
              && launchRequest.repoPath !== owned.repoPath
            )
          );
          if (expectedGovernance && !lane) {
            // The provider effect is durable, but the isolated checkout/session was
            // never brought under lane control. Keep the exact mutation unresolved
            // rather than reporting a launch that the control plane cannot govern.
            return null;
          }
          const ok = owned.outcome !== 'failed';
          return {
            ok,
            runtime: launchRequest.runtime,
            clientMutationId,
            surfaceId: owned.surfaceId,
            note: ok
              ? 'Recovered the owned runtime launch from its durable session record.'
              : 'The owned runtime launch failed after its durable session record was created.',
            cwd: owned.cwd,
            repoPath: launchRequest.repoPath ?? owned.repoPath,
            worktree: null,
            laneId: lane?.id ?? owned.laneId ?? launchRequest.existingLaneId ?? null,
          };
        },
      },
      async () => {
        try {
          return await launchRuntimeSurface(launchRequest);
        } catch (error) {
          if (error instanceof RuntimeLaunchPostEffectError) {
            return {
              ...error.result,
              outcomeUnknown: true,
              retryable: false,
            };
          }
          throw error;
        }
      },
    );

    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        runtime: launchRequest.runtime,
        clientMutationId,
        surfaceId: '',
        note: outcomeUnknown
          ? 'The prior runtime launch crossed an external side-effect boundary, but its governed result cannot be reconstructed. It was not executed twice.'
          : 'An identical runtime launch is already in progress; it was not executed twice.',
        cwd: launchRequest.cwd ?? '',
        repoPath: launchRequest.repoPath ?? launchRequest.cwd ?? '',
        worktree: null,
        laneId: launchRequest.existingLaneId ?? null,
        deduped: true,
        replayed: true,
        inProgress: true,
        outcomeUnknown: outcomeUnknown || undefined,
      }, {
        status: outcomeUnknown ? 409 : 202,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'x-o8-idempotency-replayed': '1',
        },
      });
    }

    const result = outcome.result;

    if (outcome.persistenceDegraded) {
      console.error(
        `[runtime-launch] ${clientMutationId} completed, but its persisted replay receipt could not be finalized`,
      );
    }

    if (!outcome.replayed && result.ok) {
      invalidateCommandCenterSnapshotCaches();
      invalidateInboxCache();
    }
    if (!outcome.replayed) {
      await publishRealtimeMutation({
        mutation: {
          mutationId: clientMutationId,
          source: 'desktop',
          action: 'launch',
          runtime: result.runtime,
          surfaceId: result.surfaceId,
          sessionKey: result.surfaceId,
          status: result.ok ? 'queued' : 'failed',
          note: result.note,
          createdAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
        },
        refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
        sessionKeys: result.surfaceId ? [result.surfaceId] : [],
        fresh: true,
      }).catch((error) => console.error('[runtime-launch] receipt publish failed', error));
    }

    return NextResponse.json({
      ...result,
      replayed: outcome.replayed || undefined,
      persistenceDegraded: outcome.persistenceDegraded || undefined,
    }, {
      status: result.ok ? 200 : result.outcomeUnknown ? 409 : 400,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        ...(outcome.replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
      },
    });
  } catch (error) {
    console.error('[runtime-launch]', runtimeName, error instanceof Error ? error.message : error);
    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action: 'launch',
        runtime: runtimeName ?? 'unknown',
        surfaceId: payload?.cwd?.trim() || payload?.repoPath?.trim(),
        sessionKey: payload?.cwd?.trim() || payload?.repoPath?.trim(),
        status: 'failed',
        note: error instanceof Error ? error.message : 'Unable to launch runtime session',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      fresh: true,
    }).catch((publishError) => console.error('[runtime-launch] failure publish failed', publishError));
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to launch runtime session',
      },
      { status: 500 },
    );
  }
}
