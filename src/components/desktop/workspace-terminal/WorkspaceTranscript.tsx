'use client';

import { memo } from 'react';
import { WorkerProse } from './chat-renderers/WorkerProse';
import { WorkerActivityTrace } from './chat-renderers/WorkerActivityTrace';
import { PacketWorkerHandback, WorkerHandback, type WorkerHandbackData } from './chat-renderers/WorkerHandback';
import { workerTranscriptBlocks } from './worker-activity';
import { PacketHeaderCard } from '@/components/desktop/workspace-terminal/PacketHeaderCard';
import { AgentPeerMessageCard } from '@/components/desktop/workspace-terminal/AgentPeerMessageCard';
import { WorkspaceTranscriptEventExtras } from '@/components/desktop/workspace-terminal/chat-renderers/WorkspaceTranscriptEventExtras';
import { looksLikePacketPrompt } from '@/components/desktop/workspace-terminal/workspace-chat-prompt';
import type { ClaudePermissionDecision } from '@/components/desktop/workspace-terminal/workspace-stream-events';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { AgentMessage } from '@/lib/agents/types';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';
import { useTranscriptVisualizations } from '@/components/desktop/visualizations/useTranscriptVisualizations';
import { MessageVisualizations } from '@/components/desktop/visualizations/MessageVisualizations';
import { placeTranscriptVisualizations } from '@/lib/visualizations/transcript';
import type { VisualizationReference } from '@/lib/visualizations/types';

type PermissionRequest = Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>;

export interface WorkspaceTranscriptHeader {
  enabled: boolean;
  title: string;
  branch?: string | null;
  runtime?: string | null;
  status?: string | null;
  repo?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

interface WorkspaceTranscriptProps {
  entries: MobileTranscriptEntry[];
  peerMessages?: AgentMessage[];
  peerName?: string;
  packetHeader?: WorkspaceTranscriptHeader;
  repoPath?: string | null;
  packetId?: string | null;
  active?: boolean;
  markLast?: boolean;
  isStreaming?: boolean;
  laneId?: string | null;
  onOpenReview?: () => void;
  showHandback?: boolean;
  handback?: WorkerHandbackData;
  onRunInTerminal?: (command: string) => void;
  onPermissionDecision?: (request: PermissionRequest, decision: ClaudePermissionDecision) => Promise<void> | void;
}

export type WorkspaceTranscriptRenderItem =
  | {
      kind: 'packet-header';
      key: string;
      prompt: string;
    }
  | {
      kind: 'message';
      key: string;
      entry: MobileTranscriptEntry;
      isLast: boolean;
    }
  | {
      kind: 'peer-message';
      key: string;
      message: AgentMessage;
    }
  | { kind: 'earlier-peers'; key: string; count: number };

export function composeWorkspaceChatTranscript(
  entries: MobileTranscriptEntry[],
  packetHeader?: WorkspaceTranscriptHeader,
): WorkspaceTranscriptRenderItem[] {
  return entries.map((entry, index) => {
    const isFirstUser = index === 0 && entry.role === 'user';
    const usePacketHeader = isFirstUser
      && (packetHeader?.enabled === true || looksLikePacketPrompt(entry.text));
    if (usePacketHeader) {
      return {
        kind: 'packet-header',
        key: entry.id,
        prompt: entry.text,
      };
    }
    return {
      kind: 'message',
      key: entry.id,
      entry,
      isLast: index === entries.length - 1,
    };
  });
}

/** Keep the split transcript concise while preserving the full bus history in Handoffs. */
export function composeWorkspaceTranscriptWithPeers(
  entries: MobileTranscriptEntry[],
  peerMessages: AgentMessage[],
  packetHeader?: WorkspaceTranscriptHeader,
): WorkspaceTranscriptRenderItem[] {
  const transcript = composeWorkspaceChatTranscript(entries, packetHeader);
  if (peerMessages.length === 0) return transcript;
  const chronologicalPeers = [...peerMessages].sort((a, b) => a.sequence - b.sequence);
  const visiblePeers = chronologicalPeers.slice(-8);
  const combined = [
    ...transcript.map((item, index) => ({
      item,
      timestamp: entries[index]?.timestamp ?? Number.NEGATIVE_INFINITY,
      order: index,
    })),
    ...visiblePeers.map((message, index) => ({
      item: { kind: 'peer-message' as const, key: `peer:${message.id}`, message },
      timestamp: Date.parse(message.timestamp),
      order: entries.length + index,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.order - b.order).map(({ item }) => item);
  const hidden = chronologicalPeers.length - visiblePeers.length;
  return hidden > 0 ? [{ kind: 'earlier-peers', key: 'earlier-peers', count: hidden }, ...combined] : combined;
}

export const WorkspaceTranscript = memo(function WorkspaceTranscript({
  entries,
  peerMessages = [],
  peerName,
  packetHeader,
  repoPath,
  packetId,
  active = true,
  markLast = true,
  isStreaming = false,
  onRunInTerminal,
  onPermissionDecision,
  laneId,
  onOpenReview,
  handback,
  showHandback = true,
}: WorkspaceTranscriptProps) {
  const renderItems = composeWorkspaceTranscriptWithPeers(entries, peerMessages, packetHeader);
  const references = useTranscriptVisualizations({ packetId, active, length: entries.length });
  const buckets = placeTranscriptVisualizations(references, entries);
  const byEntry = new Map(entries.map((entry, index) => [entry.id, buckets.get(index)]));

  const itemById = new Map(renderItems.map(item => [item.key, item]));
  const blocks = workerTranscriptBlocks(renderItems.map(item => item.kind === 'message' ? item.entry
    : { id: item.key, role: item.kind === 'packet-header' ? 'user' : 'system', text: '\u200b' }), isStreaming || !markLast);
  return <div data-worker-transcript style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, width: '100%', fontSize: 13, fontWeight: 300 }}>
    <MessageVisualizations references={buckets.get(-1)} />
    {blocks.map((block, index) => {
      if (block.kind === 'activity') return <WorkerActivityTrace key={block.id} block={block} />;
      const item = itemById.get(block.id);
      if (!item) return null;
      if (item.kind === 'earlier-peers') {
        return <div key={item.key} style={{ color: 'var(--t-text-faint)', fontSize: 10.5 }}>Showing the latest 8 agent messages · {item.count} earlier in Handoffs</div>;
      }
      if (item.kind === 'peer-message') {
        return <AgentPeerMessageCard key={item.key} message={item.message} selfName={peerName ?? ''} />;
      }
      if (item.kind === 'packet-header') {
        return (
          <div key={item.key} data-o8-message-id={item.key}><PacketHeaderCard
            title={packetHeader?.title ?? 'Dispatched packet'}
            branch={packetHeader?.branch}
            runtime={packetHeader?.runtime}
            status={packetHeader?.status}
            repo={packetHeader?.repo}
            launchContext={packetHeader?.launchContext}
            prompt={item.prompt}
          /></div>
        );
      }

      return (
        <WorkspaceTranscriptMessage
          key={item.key}
          entry={item.entry}
          prose={block.entry}
          references={byEntry.get(item.entry.id)}
          marginTop={index > 0 && block.entry.role === 'user' ? 8 : 0}
          repoPath={repoPath}
          onRunInTerminal={onRunInTerminal}
          onPermissionDecision={onPermissionDecision}
        />
      );
    })}
    {showHandback ? handback && markLast && !isStreaming ? <WorkerHandback data={handback} repoPath={repoPath} onReview={onOpenReview} />
      : <PacketWorkerHandback laneId={laneId ?? packetId} repoPath={repoPath} finished={markLast && !isStreaming} revision={entries.at(-1)?.id ?? ''} onReview={onOpenReview} /> : null}
  </div>;
});

const WorkspaceTranscriptMessage = memo(function WorkspaceTranscriptMessage({
  entry, prose, references, marginTop, repoPath, onRunInTerminal, onPermissionDecision,
}: Pick<WorkspaceTranscriptProps, 'repoPath' | 'onRunInTerminal' | 'onPermissionDecision'> & {
  entry: MobileTranscriptEntry;
  prose: MobileTranscriptEntry;
  references?: VisualizationReference[];
  marginTop: number;
}) {
  return <div data-o8-message-id={entry.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', width: '100%', marginTop }}>
    <WorkerProse entry={prose} repoPath={repoPath} onRunInTerminal={onRunInTerminal} />
    <MessageVisualizations references={references} />
    <WorkspaceTranscriptEventExtras entry={entry} onPermissionDecision={onPermissionDecision} />
  </div>;
});
