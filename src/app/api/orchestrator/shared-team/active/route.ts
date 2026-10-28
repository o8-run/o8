import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readActiveSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { findOwnedLaunchByMutationId, readOwnedSessionDisplay } from '@/lib/runtimes/shared/owned-session-index';
import { readSharedTeamsForThread } from '@/lib/orchestrator/shared-team-history';
import { listSharedWorkerReturns } from '@/lib/orchestrator/shared-worker-returns';
import { readWorkerRecovery } from '@/lib/agent-control/worker-recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim();
  if (!repoPath || !repoPath.startsWith('/') || repoPath.length > 4_096) {
    return NextResponse.json({ error: 'A valid repoPath is required.' }, { status: 400 });
  }
  try {
    const threadId = request.nextUrl.searchParams.get('threadId');
    if (threadId !== null) {
      if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(threadId)) {
        return NextResponse.json({ error: 'A valid threadId is required.' }, { status: 400 });
      }
      const teams = await readSharedTeamsForThread(repoPath, threadId);
      const returns = new Map(listSharedWorkerReturns(threadId).map(row => [row.surface_id, row]));
      const recorded = teams.flatMap(team => team.members.filter(member => member.surfaceId));
      const members = new Map(recorded.map(member => [member.surfaceId!, member]));
      const origins = new Map<string, Set<string>>();
      for (const member of recorded) if (member.parentTurnId) {
        const values = origins.get(member.surfaceId!) ?? new Set<string>();
        values.add(member.parentTurnId); origins.set(member.surfaceId!, values);
      }
      const workers = await Promise.all([...members.values()].map(async member => {
        const session = await readOwnedSessionDisplay(member.surfaceId!);
        return { sessionKey: member.surfaceId!, name: member.taskName, runtime: member.runtime,
          parentTurnId: origins.get(member.surfaceId!)?.size === 1 ? [...origins.get(member.surfaceId!)!][0] : null,
          returnStatus: returns.get(member.surfaceId!)?.status ?? null,
          returnReason: returns.get(member.surfaceId!)?.reason ?? null,
          model: session?.model ?? member.workerRouting?.selectedModel ?? null, effort: member.workerRouting?.selectedEffort ?? null,
          recovery: await readWorkerRecovery(member.surfaceId!),
          status: session?.status ?? 'unknown' };
      }));
      return NextResponse.json({ threadId, workers }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const team = readActiveSharedCheckoutTeam(repoPath);
    const members = team ? await Promise.all(team.members.filter((member) => member.surfaceId)
      .map(async ({ surfaceId, runtime: workerRuntime, taskName, state, clientMutationId }) => {
        const launch = await findOwnedLaunchByMutationId(clientMutationId);
        return { surfaceId, runtime: workerRuntime, taskName, state,
          outcome: launch?.surfaceId === surfaceId ? launch.outcome : 'unknown' };
      })) : [];
    return NextResponse.json({
      team: team ? {
        repoPath: team.path,
        parentThreadId: team.parentThreadId,
        members,
      } : null,
    });
  } catch {
    return NextResponse.json({ error: 'Unable to read the active Shared team.' }, { status: 500 });
  }
}
