import type {
  MobilePendingTurnWorkers,
  MobileTurnReceipt,
} from '@/lib/mobile/types';

type TurnReceiptWorker = NonNullable<MobileTurnReceipt['workers']>[number];

export function mergeMobileTurnReceipts(
  existing: MobileTurnReceipt | undefined,
  incoming: MobileTurnReceipt | undefined,
): MobileTurnReceipt | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const workers = new Map<string, NonNullable<MobileTurnReceipt['workers']>[number]>();
  for (const worker of existing.workers ?? []) workers.set(worker.packetId, worker);
  for (const worker of incoming.workers ?? []) workers.set(worker.packetId, worker);

  return {
    ...existing,
    ...incoming,
    effortSource: incoming.effortSource,
    ...(existing.terminal && existing.terminal.outcome !== 'unconfirmed' ? { terminal: existing.terminal } : {}),
    ...(workers.size > 0 ? { workers: Array.from(workers.values()) } : {}),
  };
}

export function appendPendingTurnWorker(
  pending: MobilePendingTurnWorkers | undefined,
  messageId: string,
  worker: TurnReceiptWorker,
): MobilePendingTurnWorkers {
  const workers = new Map((pending?.[messageId] ?? []).map((row) => [row.packetId, row]));
  workers.set(worker.packetId, worker);
  return {
    ...pending,
    [messageId]: Array.from(workers.values()),
  };
}

export function consumePendingTurnWorkers<
  T extends { id?: unknown; receipt?: unknown },
>(
  pending: MobilePendingTurnWorkers | undefined,
  messages: T[],
): { messages: T[]; pending: MobilePendingTurnWorkers | undefined } {
  if (!pending || Object.keys(pending).length === 0) return { messages, pending: undefined };
  const nextPending = { ...pending };
  let changed = false;
  const nextMessages = messages.map((message) => {
    const messageId = typeof message.id === 'string' ? message.id : null;
    const receipt = message.receipt && typeof message.receipt === 'object'
      ? message.receipt as MobileTurnReceipt
      : undefined;
    const workers = messageId ? nextPending[messageId] : undefined;
    if (!messageId || !receipt || !workers?.length) return message;
    delete nextPending[messageId];
    changed = true;
    return {
      ...message,
      receipt: mergeMobileTurnReceipts(receipt, { ...receipt, workers }),
    };
  });
  return {
    messages: changed ? nextMessages : messages,
    pending: Object.keys(nextPending).length > 0 ? nextPending : undefined,
  };
}
