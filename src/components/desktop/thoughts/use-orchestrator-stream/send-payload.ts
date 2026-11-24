import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { OrchestratorPermissionMode } from './shared';
import type { OrchestratorServiceTier } from '@/lib/orchestrator/service-tier';

export function buildOrchestratorSendPayload(input: {
  pinBackend?: boolean;
  repoPath: string;
  projectId?: string | null;
  threadId: string;
  clientMessageId: string;
  wireMessage: string;
  displayMessage: string;
  permissionMode: OrchestratorPermissionMode;
  orchestrationMode: OrchestratorExecutionMode;
  pickedMode?: ComposerWireMode;
  thinkingEffort?: ThinkingEffort;
  serviceTier?: OrchestratorServiceTier;
  model: string;
  backend?: OrchestratorBackendId;
  collideBaseBackend?: OrchestratorBackendId;
  handoffMode?: 'handoff';
  attachments?: Array<{ dataUri: string; name?: string }>;
}): string {
  return JSON.stringify({
    type: 'orchestrator-send',
    ...(input.pinBackend ? { pinBackend: true } : {}),
    repoPath: input.repoPath,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    message: input.wireMessage,
    displayMessage: input.displayMessage,
    permissionMode: input.permissionMode,
    orchestrationMode: input.orchestrationMode,
    ...(input.pickedMode ? { pickedMode: input.pickedMode } : {}),
    ...(input.thinkingEffort && input.thinkingEffort !== 'adaptive'
      ? { thinkingEffort: input.thinkingEffort }
      : {}),
    model: input.model,
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.collideBaseBackend ? { collideBaseBackend: input.collideBaseBackend } : {}),
    ...(input.handoffMode ? { handoffMode: input.handoffMode } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
}
