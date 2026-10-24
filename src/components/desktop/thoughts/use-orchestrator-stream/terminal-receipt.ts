import type { MobileTranscriptEntry, MobileTurnReceipt } from '@/lib/mobile/types';
import { isComposerWireMode } from '@/lib/orchestrator/composer-wire';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { isOrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';

export function parseTerminalUsage(value: unknown): MobileTranscriptEntry['tokens'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const token = (candidate: unknown) => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : 0
  );
  return {
    input: token(usage.inputTokens),
    output: token(usage.outputTokens),
    ...(usage.cacheObserved === false ? { cacheObserved: false } : {}),
    ...(typeof usage.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens) && usage.cacheReadTokens >= 0 ? { cacheRead: usage.cacheReadTokens } : {}),
    ...(typeof usage.cacheWriteTokens === 'number' && Number.isFinite(usage.cacheWriteTokens) && usage.cacheWriteTokens >= 0 ? { cacheWrite: usage.cacheWriteTokens } : {}),
    ...(typeof usage.cacheRetentionMs === 'number' && usage.cacheRetentionMs > 0 && usage.cacheRetentionMs <= 86400_000 ? { cacheRetentionMs: usage.cacheRetentionMs } : {}),
  };
}

export function parseTerminalTurnReceipt(value: unknown): MobileTurnReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.leadModel !== 'string' || !receipt.leadModel.trim()) return undefined;
  if (!isThinkingEffort(receipt.effort) || !isComposerWireMode(receipt.mode)) return undefined;
  if (receipt.pickedMode !== undefined && !isComposerWireMode(receipt.pickedMode)) return undefined;
  if (receipt.permissionMode !== undefined && !isOrchestratorPermissionMode(receipt.permissionMode)) return undefined;

  let workers: MobileTurnReceipt['workers'];
  if (receipt.workers !== undefined) {
    if (!Array.isArray(receipt.workers)) return undefined;
    workers = [];
    for (const value of receipt.workers) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const worker = value as Record<string, unknown>;
      if (typeof worker.packetId !== 'string' || !worker.packetId.trim()) return undefined;
      if (!isOrchestratorRuntime(worker.runtime)) return undefined;
      if (typeof worker.model !== 'string' || !worker.model.trim()) return undefined;
      workers.push({ packetId: worker.packetId, runtime: worker.runtime, model: worker.model });
    }
  }

  return {
    leadModel: receipt.leadModel,
    effort: receipt.effort,
    mode: receipt.mode,
    ...(isOrchestratorPermissionMode(receipt.permissionMode) ? { permissionMode: receipt.permissionMode } : {}),
    ...(receipt.pickedMode ? { pickedMode: receipt.pickedMode } : {}),
    ...(workers ? { workers } : {}),
  };
}
