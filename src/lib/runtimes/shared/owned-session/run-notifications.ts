import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from './types';
import { nowIso } from './helpers';

export async function emitRuntimeFallbackNotification(
  runtimeId: string, session: OwnedSessionRecord, fromModel: string, toModel: string, reason: string,
) {
  try {
    const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
    publishRealtimeMutation({
      mutation: {
        mutationId: `runtime-fallback-${session.surfaceId}-${Date.now()}`,
        source: 'server', action: 'runtime-fallback', status: 'completed',
        runtime: runtimeId as OrchestratorRuntime, surfaceId: session.surfaceId, sessionKey: session.surfaceId,
        note: `${runtimeId} ${fromModel} → ${toModel}: ${reason}`,
        createdAt: nowIso(), settledAt: nowIso(), fromModel, toModel, reason,
      } as unknown as Parameters<typeof publishRealtimeMutation>[0]['mutation'],
      refreshTargets: ['global', 'sessionHistory'], sessionKeys: [session.surfaceId], fresh: true,
    });
  } catch (err) { console.error('[owned-store] emitRuntimeFallbackNotification failed:', err); }
}

export async function notifySupervisorOfCleanExit(surfaceId: string, runId: string): Promise<void> {
  try {
    const [{ resolvePortInfo }, { getOrCreateWsToken }] = await Promise.all([
      import('@/lib/panel/api-port'),
      import('@/lib/ws-auth'),
    ]);
    const { wsPort } = resolvePortInfo();
    await fetch(`http://127.0.0.1:${wsPort}/supervisor/completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ surfaceId, runId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn(`[owned-session] completion push failed for ${surfaceId} (salvage nets remain):`, err);
  }
}
