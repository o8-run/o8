import { randomUUID } from 'node:crypto';
import {
  parseSymonPendingConfirmation,
  type SymonPendingConfirmation,
} from '@/lib/mobile/symon-tool-relay';

export const PHONE_CONFIRM_TIMEOUT_MS = 120_000;
/** Trusted server preparation may supply a richer review before execution. */
export type PhoneToolReview = Pick<SymonPendingConfirmation, 'summary' | 'target' | 'kind' | 'plan'>;

export function createPhoneConfirmation(
  call: { sessionId: string; callId: string; tool: string; args: Record<string, unknown> },
  review?: PhoneToolReview,
): SymonPendingConfirmation | null {
  const target: SymonPendingConfirmation['target'] = {};
  for (const key of ['approvalId', 'packetId', 'laneId', 'sessionKey'] as const) {
    const value = call.args[key];
    if (typeof value === 'string' && value.trim()) target[key] = value.trim();
  }
  return parseSymonPendingConfirmation({
    sessionId: call.sessionId,
    callId: call.callId,
    tool: call.tool,
    ...review,
    confirmationId: randomUUID(),
    taskId: randomUUID(),
    summary: review?.summary ?? `Run ${call.tool}`,
    target: review?.target ?? target,
    expiresAt: Date.now() + PHONE_CONFIRM_TIMEOUT_MS,
  }, call);
}
