'use client';

import { useState } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';

/** Only server lifecycle receipts can mark a compaction live, never history. */
export function useLiveCompaction(repoPath: string | null | undefined, threadId: string | null | undefined): boolean {
  const scope = JSON.stringify([repoPath, threadId]);
  const [saved, setSaved] = useState<{ scope: string; operations: Map<string, boolean> } | null>(null);
  if (saved && saved.scope !== scope) setSaved(null);
  useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    if (event.channel !== 'mutation' || !repoPath || !threadId) return;
    const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
    if (mutation?.action !== 'orchestrator-compaction' || mutation.source !== 'server'
      || mutation.repoPath !== repoPath || mutation.surfaceId !== threadId) return;
    const pending = mutation.status === 'pending';
    if (pending && (event.delivery === 'replay' || event.delivery === 'bootstrap')) return;
    if (!pending && mutation.status !== 'completed' && mutation.status !== 'failed') return;
    setSaved(previous => {
      const operations = new Map(previous?.scope === scope ? previous.operations : []);
      // A terminal receipt is final, even if its start arrives late.
      if (pending && operations.get(mutation.mutationId) === false) return previous;
      operations.set(mutation.mutationId, pending);
      return { scope, operations: new Map([...operations].slice(-64)) };
    });
  } });
  return saved?.scope === scope && [...saved.operations.values()].some(Boolean);
}
