import type { ComposerClaim } from '@/lib/ws-server/composer-owner-rpc';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { ComposerExecutorAttempt } from '@/lib/ws-server/composer-executor-attempt';
import { runQueuedComposerSend as send, runQueuedComposerSteer as steer } from '@/lib/ws-server/composer-queue-heartbeat';
import type { BoundChatContinuationHooks } from '@/lib/ws-server/bound-chat-continuation';

// Test adapter only: old assertions still inspect the public item; the private
// claim receipt is retained beside it, never added to a public item or wire.
const tokens = new Map<string, string>();
export async function fixtureComposerClaim(claim: Promise<ComposerClaim>): Promise<QueuedComposerSendRecord | null> {
  const value = await claim;
  if (value.item && value.claimToken) tokens.set(value.item.id, value.claimToken);
  return value.item;
}
export function fixtureComposerToken(id: string): string {
  const token = tokens.get(id);
  if (!token) throw new Error(`Fixture ${id} has no native claim receipt.`);
  return token;
}
export function runQueuedComposerSteer(item: QueuedComposerSendRecord) {
  const token = fixtureComposerToken(item.id);
  return steer(item, new ComposerExecutorAttempt(item.id, token), token);
}
export function runQueuedComposerSend(item: QueuedComposerSendRecord, hooks: BoundChatContinuationHooks) {
  return send(item, hooks, new ComposerExecutorAttempt(item.id, fixtureComposerToken(item.id)));
}

export async function recoverComposerOwner(): Promise<void> {
  const fixture = await import('./composer-queue-owner');
  await fixture.recoverComposerOwner();
}
