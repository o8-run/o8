import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { isManualThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/** Native live input cannot change the running turn's reasoning configuration. */
export function assertCodexLiveSteerEffort(effort: ThinkingEffort | undefined): void {
  if (isManualThinkingEffort(effort)) {
    throw new EffortPinRejectionError('effort_unsupported_runtime',
      `Live steering cannot apply effort "${effort}" to a running turn. Queue a new turn or omit the effort pin.`);
  }
}
