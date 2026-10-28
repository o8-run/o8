import type { TranscriptReadingAnchor } from './transcript-reading-anchor';

export interface TranscriptReadingPosition {
  following: boolean;
  top: number;
  anchor: TranscriptReadingAnchor | null;
}

const key = (scope: string) => `o8:transcript-reading:v1:${scope}`;

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
      || typeof row.id !== 'string' || !row.id || typeof row.offset !== 'number' || !Number.isFinite(row.offset)))) return null;
    return { following: position.following, top: position.top,
      anchor: Array.isArray(rows) && rows.length ? { rows: rows.map(({ id, offset }) => ({ id, offset })) } : null };
  } catch {
    return null;
  }
}

/** Store identities and offsets only, never DOM nodes or transcript content. */
export function saveTranscriptReadingPosition(scope: string | null, position: TranscriptReadingPosition): void {
  if (!scope) return;
  try {
    window.localStorage.setItem(key(scope), JSON.stringify({ ...position,
      anchor: position.anchor ? { rows: position.anchor.rows.map(({ id, offset }) => ({ id, offset })) } : null,
    }));
  } catch {
    // Scrolling still works when storage is blocked or full.
  }
}
