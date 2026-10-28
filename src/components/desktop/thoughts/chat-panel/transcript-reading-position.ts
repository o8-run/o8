import type { TranscriptReadingAnchor } from './transcript-reading-anchor';

export interface TranscriptReadingPosition {
  following: boolean;
  top: number;
  anchor: TranscriptReadingAnchor | null;
}

const PREFIX = 'o8:transcript-reading:v1:';
const key = (scope: string) => PREFIX + scope;

export function loadTranscriptReadingPosition(scope: string | null): TranscriptReadingPosition | null {
  if (!scope) return null;
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(key(scope)) ?? 'null');
    if (!stored || typeof stored !== 'object') return null;
    const position = stored as Record<string, unknown>;
    if (typeof position.following !== 'boolean' || typeof position.top !== 'number'
      || !Number.isFinite(position.top) || position.top < 0) return null;
    const rows = (position.anchor as { rows?: unknown } | null)?.rows;
    if (rows !== undefined && (!Array.isArray(rows) || rows.length > 3 || rows.some(row => !row
      || typeof row.id !== 'string' || !row.id || typeof row.offset !== 'number' || !Number.isFinite(row.offset)
      || (row.index !== undefined && (!Number.isSafeInteger(row.index) || row.index < 0))))) return null;
    return { following: position.following, top: position.top,
      anchor: Array.isArray(rows) && rows.length ? { rows: rows.map(({ id, offset, index }) => ({ id, offset, index })) } : null };
  } catch {
    return null;
  }
}

/** Store identities and offsets only, never DOM nodes or transcript content. */
export function saveTranscriptReadingPosition(scope: string | null, position: TranscriptReadingPosition): void {
  if (!scope) return;
  try {
    window.localStorage.setItem(key(scope), JSON.stringify({ ...position,
      anchor: position.anchor ? { rows: position.anchor.rows.map(({ id, offset, index }) => ({ id, offset, index })) } : null,
    }));
  } catch {
    // Scrolling still works when storage is blocked or full.
  }
}

function conversationId(scope: string | null): string | null {
  try {
    const parts: unknown = JSON.parse(scope ?? 'null');
    return Array.isArray(parts) && parts.length === 3 && ['thread', 'session'].includes(parts[1])
      && typeof parts[2] === 'string' ? parts[2] : null;
  } catch { return null; }
}

const deletionListeners = new Set<(tabId: string) => void>();

/** Delete every workspace bucket, even when no transcript is currently mounted. */
export function removeTranscriptReadingPositions(tabId: string): void {
  deletionListeners.forEach(listener => listener(tabId));
  try {
    for (const candidate of Object.keys(window.localStorage)) {
      if (candidate.startsWith(PREFIX) && conversationId(candidate.slice(PREFIX.length)) === tabId) {
        window.localStorage.removeItem(candidate);
      }
    }
  } catch { /* Deletion still works when browser storage is unavailable. */ }
}

export function observeTranscriptReadingDeletions(onDeleted: (tabId: string) => void): () => void {
  deletionListeners.add(onDeleted);
  const handle = (event: Event) => {
    const tabId = (event as CustomEvent<{ tabId?: unknown }>).detail?.tabId;
    if (typeof tabId === 'string' && tabId) removeTranscriptReadingPositions(tabId);
  };
  const events = ['o8:chat-history-deleted', 'cortex-llm-history-deleted'];
  for (const name of events) window.addEventListener(name, handle);
  return () => {
    deletionListeners.delete(onDeleted);
    for (const name of events) window.removeEventListener(name, handle);
  };
}

export function isTranscriptReadingConversation(scope: string | null, tabId: string): boolean {
  return conversationId(scope) === tabId;
}
