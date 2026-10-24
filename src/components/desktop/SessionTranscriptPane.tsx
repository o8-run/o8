'use client';

import { workerPacketForSession } from '@/lib/orchestrator/worker-session-packet';

/**
 * SessionTranscriptPane — sessionKey-only transcript surface.
 *
 * Thin adapter over AgentTilePane that resolves the agent record from the
 * orchestrator data context, so the pane can mount in any tile (split-pane
 * orchestrator transcripts, future side-by-side comparison views, etc.)
 * without callers having to thread agent metadata through.
 *
 * Issue #663: extract per-session transcript view as
 * <SessionTranscriptPane sessionKey={key} /> so it can mount in any tile.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOrchestratorData } from './orchestrator-data-context';
import { AgentTilePane } from './workspace-terminal/AgentTilePane';
import type { FleetAgent } from './thoughts/types';
import { DEGRADED_FALLBACK_REFRESH_MS, startDurableRefresh } from '@/lib/panel/durable-refresh';

interface SessionTranscriptPaneProps {
  sessionKey: string;
  focused?: boolean;
  onFocus?: (sessionKey: string) => void;
  onClose?: (sessionKey: string) => void;
}

export function SessionTranscriptPane({
  sessionKey,
  focused = false,
  onFocus,
  onClose,
}: SessionTranscriptPaneProps) {
  const data = useOrchestratorData();
  const agent = useMemo(
    () => (data?.agents ?? []).find((entry) => entry.sessionKey === sessionKey) ?? null,
    [data?.agents, sessionKey],
  );
  const [savedAgent, setSavedAgent] = useState<{ sessionKey: string; agent: FleetAgent } | null>(null);
  useEffect(() => {
    if (agent || !sessionKey.includes('-owned:')) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/api/runtime/session-summary?sessionKey=${encodeURIComponent(sessionKey)}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok || controller.signal.aborted) return;
        const payload = await response.json() as { session?: FleetAgent };
        if (controller.signal.aborted || payload.session?.sessionKey !== sessionKey) return;
        setSavedAgent({ sessionKey, agent: payload.session });
      } catch { /* Preserve the last runtime evidence during transient outages. */ }
    };
    void refresh();
    const stopRefresh = startDurableRefresh({
      refresh,
      intervalMs: DEGRADED_FALLBACK_REFRESH_MS,
      events: ['o8:lifecycle-reconcile', 'cortex:agent-supervisor-update'],
    });
    return () => { stopRefresh(); controller.abort(); };
  }, [agent, sessionKey]);
  const packet = useMemo(
    () => workerPacketForSession(data?.missionState?.packets ?? [], sessionKey),
    [data?.missionState?.packets, sessionKey],
  );

  const handleFocus = useCallback((key: string) => {
    onFocus?.(key);
  }, [onFocus]);

  const handleClose = useCallback((key: string) => {
    onClose?.(key);
  }, [onClose]);
  const handleOpenReview = useCallback(() => {
    if (!packet?.lane?.laneId) return;
    data?.onOpenO8Panel?.({
      tab: 'review',
      reviewLaneId: packet.lane.laneId,
      repoPath: packet.lane.repoPath ?? null,
    });
  }, [data, packet]);

  return (
    <AgentTilePane
      sessionKey={sessionKey}
      agent={agent ?? (savedAgent?.sessionKey === sessionKey ? savedAgent.agent : null)}
      packet={packet}
      focused={focused}
      onClose={handleClose}
      onFocus={handleFocus}
      onOpenReview={packet?.lane?.laneId && data?.onOpenO8Panel ? handleOpenReview : undefined}
    />
  );
}
