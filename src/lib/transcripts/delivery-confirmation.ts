interface DeliveryEntry {
  id?: unknown;
  role?: unknown;
  deliveryConfirmed?: unknown;
}

/** Modern send IDs are correlated identities, not legacy optimistic echoes. */
export function areDistinctOrchestratorSends(left: DeliveryEntry, right: DeliveryEntry): boolean {
  const correlated = (id: unknown): id is string => typeof id === 'string'
    && (id.startsWith('orch-user-orch-send-') || id.startsWith('composer-steer-'));
  return left.role === 'user' && right.role === 'user'
    && correlated(left.id) && correlated(right.id)
    && left.id !== right.id;
}

/** A stale source cannot revoke acknowledgement; this does not mean turn success. */
export function preserveDeliveryConfirmation<T extends DeliveryEntry>(previous: T, incoming: T): T {
  return previous.deliveryConfirmed === true && incoming.deliveryConfirmed !== true
    ? { ...incoming, deliveryConfirmed: true }
    : incoming;
}

/** Retire only the system warning for the exact confirmed user send. */
export function removeConfirmedDeliveryWarnings<T extends DeliveryEntry>(messages: T[]): T[] {
  const confirmed = new Set(messages.flatMap((entry) => entry.role === 'user' && entry.deliveryConfirmed === true
    && typeof entry.id === 'string' && entry.id.startsWith('orch-user-')
    ? [`orch-delivery-error-${entry.id.slice('orch-user-'.length)}`]
    : []));
  if (confirmed.size === 0) return messages;
  const next = messages.filter((entry) => entry.role !== 'system'
    || typeof entry.id !== 'string' || !confirmed.has(entry.id));
  return next.length === messages.length ? messages : next;
}
