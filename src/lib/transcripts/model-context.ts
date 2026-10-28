interface ModelContextEntry {
  id?: string;
  type?: string;
  pinned?: boolean;
  compaction?: { source?: string; compactedThroughId?: string; summarizedMessageIds?: string[] };
}

/** Model context is a projection; compaction never truncates the visible record. */
export function projectModelContext<T extends ModelContextEntry>(messages: T[]): T[] {
  const summary = messages.findLast(entry => entry.compaction?.source === 'summary');
  const summarizedIds = summary?.compaction?.summarizedMessageIds;
  if (summary && summarizedIds) {
    const covered = new Set(summarizedIds);
    return [summary, ...messages.filter(entry => entry.type !== 'compaction'
      && (entry.pinned === true || !entry.id || !covered.has(entry.id)))];
  }
  const throughId = summary?.compaction?.compactedThroughId;
  const boundary = throughId ? messages.findIndex(entry => entry.id === throughId) : -1;
  // Legacy summaries already replaced their prefix. Preserve that input shape
  // until a new summary records an explicit identity boundary.
  if (!summary || boundary < 0) return messages;
  return [summary, ...messages.filter((entry, index) => entry.type !== 'compaction'
    && (entry.pinned === true || index > boundary))];
}
