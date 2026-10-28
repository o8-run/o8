import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { OrchestratorServiceTier } from '@/lib/orchestrator/service-tier';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

export type ComposerQueueStatus = 'queued' | 'dispatching' | 'applied' | 'held' | 'cancelled';
export interface ComposerQueuePayload {
  /** A deliberate follow-up may run only after this exact task settles. */
  afterTaskId?: string;
  text: string;
  wireMessage: string;
  images: Array<{ name: string; dataUri: string }>;
  routing: {
    backend: OrchestratorBackendId;
    /** Refuse route normalization or fallback for a bound voice request. */
    pinBackend?: true;
    model: string;
    effort: ThinkingEffort;
    serviceTier?: OrchestratorServiceTier;
    permissionMode: import('@/lib/orchestrator/permission-mode').OrchestratorPermissionMode;
    mode: OrchestratorExecutionMode;
    pickedMode: ComposerWireMode;
    collide: boolean;
    projectId?: string;
  };
}
export interface ComposerQueueTarget { repoPath: string; threadId: string }
export interface QueuedComposerSendRecord extends ComposerQueueTarget {
  id: string;
  sequence: number;
  intent: 'send-next' | 'steer-now';
  payload: ComposerQueuePayload;
  status: ComposerQueueStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  admittedAt: number | null;
  steerAnchor?: import('@/lib/transcripts/steer-anchor').SteerTranscriptAnchor;
}
