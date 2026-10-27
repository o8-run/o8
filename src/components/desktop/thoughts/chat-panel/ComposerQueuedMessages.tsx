'use client';

import type { ReactNode } from 'react';
import { DesktopAgentMessage } from '../../DesktopAgentMessage';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

export interface ComposerTranscriptQueue {
  items: readonly QueuedComposerSendRecord[];
  canSteer: boolean;
  onSteer: (id: string) => void;
  onCancel: (sequence: number) => void;
  removing?: ReadonlySet<number>;
  promoting?: ReadonlySet<string>;
  steerableIds?: ReadonlySet<string>;
}

export function composerSendForEntry(id: string, items: readonly QueuedComposerSendRecord[]) {
  return items.find(item => [`composer-steer-${item.id}`, `composer-queued-${item.id}`, `review-user-assistant-queued-${item.id}`].includes(id));
}

export function ComposerDeliveryTag({ item, queue }: { item: QueuedComposerSendRecord; queue: ComposerTranscriptQueue }) {
  const applied = item.status === 'applied';
  const promoting = queue.promoting?.has(item.id);
  const pendingSteer = item.intent === 'steer-now' && item.status !== 'held';
  const removing = queue.removing?.has(item.sequence);
  const cancellable = !removing && !applied && (item.status !== 'dispatching' || item.admittedAt === null);
  const label = applied ? 'Steer →' : pendingSteer ? 'Steering…' : item.status === 'held'
    ? `Queued · ${item.reason?.startsWith('Steer unconfirmed') ? 'Steer unconfirmed' : 'Needs attention'}`
    : item.status === 'dispatching' ? 'Sending…' : `Queued${item.reason?.startsWith('Steer declined') ? ' · Steer declined' : ''}`;
  const textAction = { border: 0, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', font: 'inherit', cursor: 'pointer' } as const;
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
    <span role="status" title={item.reason ?? undefined}>{label}{item.status === 'held' && item.reason ? `: ${item.reason}` : ''}</span>
    {(queue.steerableIds ? queue.steerableIds.has(item.id) : queue.canSteer) && item.status === 'queued' && item.intent === 'send-next' && !item.payload.afterTaskId ? <button type="button" disabled={promoting} onClick={() => queue.onSteer(item.id)} style={{ ...textAction, cursor: promoting ? 'default' : 'pointer' }}>{promoting ? 'Steering…' : 'Steer now'}</button> : null}
    {!applied ? <button type="button" title="Cancel queued message" aria-label={`Remove queued message: ${item.payload.text}`} disabled={!cancellable}
      onClick={() => queue.onCancel(item.sequence)} style={{ ...textAction, cursor: cancellable ? 'pointer' : 'default', opacity: cancellable ? 1 : 0.45 }}>{removing ? 'Removing…' : 'Remove'}</button> : null}
  </div>;
}

/** The persisted server message id keeps old acknowledgement tags after queue pagination. */
export function ComposerEntryDelivery({ id, queue }: { id: string; queue?: ComposerTranscriptQueue }) {
  const item = queue ? composerSendForEntry(id, queue.items) : undefined;
  if (item && queue) return <ComposerDeliveryTag item={item} queue={queue} />;
  return id.startsWith('composer-steer-') ? <span style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>Steer →</span> : null;
}

export function ComposerQueuedMessages({ queue, messages }: { queue: ComposerTranscriptQueue; messages: readonly MobileTranscriptEntry[] }): ReactNode {
  const pending = queue.items.filter(item => item.status !== 'cancelled' && !messages.some(message => composerSendForEntry(message.id, [item])
    || (item.status === 'dispatching' && item.admittedAt !== null && message.role === 'user' && message.text === item.payload.text && (message.timestamp ?? 0) >= item.createdAt)));
  if (!pending.length) return null;
  return <div role="list" aria-label="Queued messages" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, gap: 18 }}>
    {pending.map(item => <div key={item.id} role="listitem" data-composer-message={item.id} style={{ opacity: item.status === 'applied' ? 1 : 0.72 }}>
      <DesktopAgentMessage entry={{ id: `composer-steer-${item.id}`, role: 'user', text: item.payload.text, timestamp: item.createdAt,
        media: item.payload.images.map(image => ({ kind: 'image', path: image.dataUri, name: image.name })) }}
        userDelivery={<ComposerDeliveryTag item={item} queue={queue} />} />
    </div>)}
  </div>;
}
