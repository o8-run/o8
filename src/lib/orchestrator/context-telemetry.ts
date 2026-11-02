import { mapLlmHistoryToMobileTranscript, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { readOrchestratorBackendSessionId } from '@/lib/mobile/orchestrator-thread-history';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { readPiOrchestratorContext } from '@/lib/pi/orchestrator/context';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';
import { projectModelContext } from '@/lib/transcripts/model-context';
import { estimateOrchestratorContext } from './context-estimate';

/** Use persisted active history so silent compaction does not re-count the
 * archived prefix still visible in the desktop transcript. */
export async function readOrchestratorContextTelemetry(threadId: string, backend: OrchestratorBackendId): Promise<RuntimeTelemetry> {
  const history = readPersistedLlmChat(threadId)?.history;
  let telemetry: RuntimeTelemetry | undefined;
  try {
    if ((backend === 'pi' || backend === 'o8') && history?.repoPath) {
      telemetry = await readPiOrchestratorContext(history.repoPath, threadId);
    } else if (backend === 'claude' || backend === 'fable' || backend === 'codex') {
      const native = backend === 'fable' ? 'claude' : backend;
      const sessionId = readOrchestratorBackendSessionId(threadId, native);
      const runtime = native === 'claude' ? 'claude-code' : 'codex';
      if (sessionId) telemetry = await getRuntime(runtime)?.getTelemetry?.(`${runtime}:${sessionId}`);
    }
  } catch { /* Missing provider telemetry uses the active transcript. */ }
  if (typeof telemetry?.contextTokens === 'number' && Number.isFinite(telemetry.contextTokens) && telemetry.contextTokens > 0) {
    return telemetry;
  }
  return {
    ...telemetry,
    contextTokens: estimateOrchestratorContext(mapLlmHistoryToMobileTranscript(projectModelContext(history?.messages ?? []))),
    contextSource: 'transcript-estimate',
  };
}
