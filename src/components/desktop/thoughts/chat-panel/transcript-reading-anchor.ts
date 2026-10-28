interface ReadingRow { id: string; offset: number; index?: number; element?: HTMLElement }
export interface TranscriptReadingAnchor { rows: ReadingRow[] }

/** Capture visible identity and offset, independently of total content height. */
export function captureTranscriptReadingAnchor(container: HTMLElement): TranscriptReadingAnchor | null {
  const bounds = container.getBoundingClientRect();
  const rows: ReadingRow[] = [];
  const capture = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return;
    const id = element.getAttribute('data-o8-message-id');
    if (id) rows.push({ id, offset: rect.top - bounds.top, element });
  };
  // Hit testing avoids laying out every deferred historical turn on each scroll.
  const hit = container.ownerDocument.elementFromPoint?.(bounds.left + bounds.width / 2, bounds.top + 1)
    ?.closest<HTMLElement>('[data-o8-message-id]');
  if (hit && container.contains(hit)) capture(hit);
  if (!rows.length) {
    for (const element of container.querySelectorAll<HTMLElement>('[data-o8-message-id]')) {
      capture(element);
      if (rows.length >= 3) break;
    }
  }
  return rows.length ? { rows } : null;
}

/** Native scroll anchoring may already have compensated; apply only the remainder. */
export function restoreTranscriptReadingAnchor(container: HTMLElement, anchor: TranscriptReadingAnchor | null): boolean {
  if (!anchor || !container.isConnected) return false;
  for (const row of anchor.rows) {
    const element = row.element && container.contains(row.element) ? row.element
      : [...container.querySelectorAll<HTMLElement>('[data-o8-message-id]')].find(node => node.getAttribute('data-o8-message-id') === row.id);
    if (!element) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.height <= 0) continue;
    const delta = bounds.top - container.getBoundingClientRect().top - row.offset;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    return true;
  }
  return false;
}

/** Resolve a pruned identity by its saved order, or its pixel position for v1 records without order. */
export function nearestTranscriptReadingAnchor(
  container: HTMLElement, anchor: TranscriptReadingAnchor, top: number, messageIds: readonly string[],
): TranscriptReadingAnchor | null {
  const saved = anchor.rows[0];
  if (!saved) return null;
  const bounds = container.getBoundingClientRect();
  let nearest: ReadingRow | null = null;
  let distance = Infinity;
  const order = new Map(messageIds.map((id, index) => [id, index]));
  for (const element of container.querySelectorAll<HTMLElement>('[data-o8-message-id]')) {
    const id = element.getAttribute('data-o8-message-id')!;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const index = order.get(id);
    const delta = saved.index !== undefined && index !== undefined
      ? Math.abs(index - saved.index)
      : Math.abs(container.scrollTop + rect.top - bounds.top - top - saved.offset);
    if (delta >= distance) continue;
    distance = delta;
    nearest = { id, offset: Math.max(0, saved.offset), index, element };
  }
  return nearest ? { rows: [nearest] } : null;
}
