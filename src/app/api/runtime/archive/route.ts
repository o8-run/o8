import { NextRequest, NextResponse } from 'next/server';
import { ownedCodexSessionState } from '@/lib/codex/owned';
import { ownedClaudeCodeSessionState } from '@/lib/claude-code/owned';
import { ownedCursorSessionState } from '@/lib/cursor/owned';
import { ownedGeminiSessionState } from '@/lib/gemini/owned';
import { ownedGrokSessionState } from '@/lib/grok/owned';
import { ownedOpencodeSessionState } from '@/lib/opencode/owned';
import { ownedPiSessionState } from '@/lib/pi/owned';
import { ownedPrimeAgentSessionState } from '@/lib/prime-agent/owned';
import { archiveLane, findLaneBySession, getLane } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { invalidateRuntimeInventoryCache } from '@/lib/runtime/inventory';
import { archiveOwnedRuntimeSession } from '@/lib/runtime/owned-session-archive';
import type { OwnedSessionState } from '@/lib/runtimes/shared/owned-session';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { matchesMutationWorkspace, mutationWorkspace, MutationWorkspaceNotFoundError } from '@/lib/repos/mutation-workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

type RuntimeArchiveTarget =
  | { sessionKey: string; laneId?: never }
  | { laneId: string; sessionKey?: never };

interface RuntimeArchiveResult {
  ok: true;
  archived: true;
  clientMutationId: string;
  sessionKey?: string;
  laneId?: string;
  note: string;
}

class RuntimeArchiveRejectedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function canonicalArchiveBody(target: RuntimeArchiveTarget, workspace: string | null | undefined): string {
  const body = target.sessionKey
    ? { sessionKey: target.sessionKey }
    : { laneId: target.laneId };
  return JSON.stringify({ ...body, ...(workspace !== undefined ? { workspace } : {}) });
}

async function assertArchiveWorkspace(target: RuntimeArchiveTarget, workspace: string | null | undefined) {
  const record = target.sessionKey ? await readOwnedSessionRecord(target.sessionKey) : getLane(target.laneId!);
  if (!record || !matchesMutationWorkspace(workspace, record.repoPath)) {
    throw new RuntimeArchiveRejectedError(404, 'Archive target was not found');
  }
}

async function readOwnedSessionState(sessionKey: string): Promise<OwnedSessionState> {
  try {
    if (sessionKey.startsWith('codex-owned:')) return await ownedCodexSessionState(sessionKey);
    if (sessionKey.startsWith('claude-code-owned:')) return await ownedClaudeCodeSessionState(sessionKey);
    if (sessionKey.startsWith('gemini-owned:')) return await ownedGeminiSessionState(sessionKey);
    if (sessionKey.startsWith('opencode-owned:')) return await ownedOpencodeSessionState(sessionKey);
    if (sessionKey.startsWith('cursor-owned:')) return await ownedCursorSessionState(sessionKey);
    if (sessionKey.startsWith('grok-owned:')) return await ownedGrokSessionState(sessionKey);
    if (sessionKey.startsWith('pi-owned:')) return await ownedPiSessionState(sessionKey);
    if (sessionKey.startsWith('prime-agent-owned:')) return await ownedPrimeAgentSessionState(sessionKey);
    await import('@/lib/runtimes');
    const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
    const registered = getOwnedSessionLifecycle(sessionKey);
    if (registered) return registered.sessionState(sessionKey);
    return 'active';
  } catch {
    return 'active';
  }
}

export async function GET(request: NextRequest) {
  const sessionKeys = Array.from(new Set(
    (request.nextUrl.searchParams.get('sessionKeys') ?? '')
      .split(',')
      .map((sessionKey) => sessionKey.trim())
      .filter(Boolean),
  )).slice(0, 100);
  const entries = await Promise.all(sessionKeys.map(async (sessionKey) => (
    [sessionKey, await readOwnedSessionState(sessionKey)] as const
  )));
  return NextResponse.json({ states: Object.fromEntries(entries) }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    sessionKey?: string;
    laneId?: string;
    clientMutationId?: string;
  } | null;
  const sessionKey = body?.sessionKey?.trim();
  const laneId = body?.laneId?.trim();
  const clientMutationId = body?.clientMutationId?.trim();
  if (!sessionKey && !laneId) {
    return NextResponse.json({ error: 'sessionKey or laneId is required' }, { status: 400, headers: NO_STORE });
  }
  if (sessionKey && laneId) {
    return NextResponse.json({ error: 'Pass sessionKey or laneId, not both' }, { status: 400, headers: NO_STORE });
  }
  if (!clientMutationId) {
    return NextResponse.json({ error: 'clientMutationId is required' }, { status: 400, headers: NO_STORE });
  }

  const target: RuntimeArchiveTarget = sessionKey ? { sessionKey } : { laneId: laneId! };
  const workspace = mutationWorkspace(request);
  const canonicalBody = canonicalArchiveBody(target, workspace);
  const scopeId = sessionKey ? `session:${sessionKey}` : `lane:${laneId!}`;

  try {
    // Admission precedes receipt binding and replay: a receipt from another
    // workspace cannot authorize this request or reserve its mutation identity.
    await assertArchiveWorkspace(target, workspace);
    const binding = bindIdempotencyClientMutation({
      namespace: 'runtime_archive',
      clientKey: clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return NextResponse.json(
        { error: 'clientMutationId was already used for a different runtime archive.' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (binding.status === 'unavailable') {
      return NextResponse.json({
        error: 'The persisted idempotency store is unavailable; the archive was not run.',
      }, { status: 503, headers: NO_STORE });
    }

    const outcome = await withIdempotency<RuntimeArchiveResult>(
      {
        key: deriveIdempotencyKey({
          verb: 'runtime_archive',
          scopeId,
          clientKey: clientMutationId,
          body: canonicalBody,
        }),
        verb: 'runtime_archive',
        scopeId,
      },
      async () => {
        await assertArchiveWorkspace(target, workspace);
        if (laneId) {
          const lane = getLane(laneId);
          if (!lane || !matchesMutationWorkspace(workspace, lane.repoPath)) {
            throw new RuntimeArchiveRejectedError(404, `Lane ${laneId} was not found`);
          }
          if (lane.sessionKey) {
            throw new RuntimeArchiveRejectedError(
              409,
              'This lane has an owned session; archive it with sessionKey so the runtime state is preserved.',
            );
          }
          if (lane.status !== 'failed' && lane.status !== 'completed' && lane.status !== 'archived') {
            throw new RuntimeArchiveRejectedError(
              409,
              `Lane ${laneId} is ${lane.status}; only terminal sessionless lanes can be archived.`,
            );
          }

          const archived = archiveLane(laneId, 'user');
          if (!archived) {
            throw new RuntimeArchiveRejectedError(404, `Lane ${laneId} was not found`);
          }
          return {
            ok: true,
            archived: true,
            laneId,
            clientMutationId,
            note: 'Sessionless terminal lane archived.',
          };
        }

        const ownedSessionKey = sessionKey!;
        const result = await archiveOwnedRuntimeSession(ownedSessionKey, workspace ?? undefined);
        if (!result) {
          throw new RuntimeArchiveRejectedError(
            400,
            `Archive is only supported for owned runtime sessions. Got prefix: ${ownedSessionKey.split(':')[0]}`,
          );
        }
        if (!result.archived) {
          throw new RuntimeArchiveRejectedError(409, result.note);
        }
        // #2154 — archiving the session dir alone left the LANE row at its
        // terminal status, so the Agents rail re-rendered the row on the next
        // poll and archiving never shrank the rail. Retire the lane too, but
        // only once its lifecycle is over: a live lane keeps its row (#2144).
        const lane = findLaneBySession(ownedSessionKey);
        const laneRetired = lane && isLaneTerminal(lane.status) && lane.status !== 'archived'
          ? Boolean(archiveLane(lane.id, 'user'))
          : false;
        return {
          ok: true,
          archived: true,
          sessionKey: ownedSessionKey,
          ...(laneRetired && lane ? { laneId: lane.id } : {}),
          clientMutationId,
          note: result.note,
        };
      },
    );

    if (outcome.inProgress) {
      const outcomeUnknown = outcome.unresolved === true;
      return NextResponse.json({
        ok: !outcomeUnknown,
        archived: false,
        clientMutationId,
        ...target,
        status: outcomeUnknown ? 'outcome_unknown' : 'in_progress',
        inProgress: true,
        replayed: true,
        outcomeUnknown: outcomeUnknown || undefined,
        note: outcomeUnknown
          ? 'The prior runtime archive process ended before its receipt was persisted. The outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect the session before taking another action.'
          : 'An identical runtime archive is already in progress; it was not executed twice.',
      }, {
        status: outcomeUnknown ? 409 : 202,
        headers: { ...NO_STORE, 'x-o8-idempotency-replayed': '1' },
      });
    }

    if (!outcome.replayed) invalidateRuntimeInventoryCache();
    return NextResponse.json({
      ...outcome.result,
      replayed: outcome.replayed || undefined,
      persistenceDegraded: outcome.persistenceDegraded || undefined,
    }, {
      headers: {
        ...NO_STORE,
        ...(outcome.replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
      },
    });
  } catch (error) {
    if (error instanceof MutationWorkspaceNotFoundError) {
      return NextResponse.json({ ok: false, archived: false, error: 'Archive target was not found' }, { status: 404, headers: NO_STORE });
    }
    if (error instanceof RuntimeArchiveRejectedError) {
      return NextResponse.json({
        ok: false,
        archived: false,
        clientMutationId,
        ...target,
        error: error.message,
        note: error.message,
      }, { status: error.status, headers: NO_STORE });
    }
    const message = error instanceof Error ? error.message : 'Failed to archive session.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
