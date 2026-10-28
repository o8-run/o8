import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { persistComposerImages } from '@/lib/mobile/orchestrator-image-media';
import type { ComposerQueuePayload } from './composer-queue-types';

export const composerPayloadHash = (serialized: string): string => createHash('sha256').update(serialized).digest('hex');

/** Keep routing/binding audit context, but no message text or attachment bytes. */
export function compactComposerPayload(serialized: string, preserveSteerMedia = false): string {
  const payload = JSON.parse(serialized) as ComposerQueuePayload;
  // Older steers used the ledger as their only media reference. Keep small
  // content-addressed transcript references, never inline screenshot bytes.
  const deliveredMedia = preserveSteerMedia && payload.images.length ? persistComposerImages(payload.images) : undefined;
  return JSON.stringify({ ...payload, text: '', wireMessage: '', images: [], ...(deliveredMedia ? { deliveredMedia } : {}) });
}

/** Clear freed overflow pages too; keep the connection's existing policy. */
export function withComposerPayloadRemoval<T>(sqlite: Database.Database, write: () => T): T {
  const previous = sqlite.pragma('secure_delete', { simple: true }) as number;
  sqlite.pragma('secure_delete = ON');
  try { return write(); } finally { sqlite.pragma(`secure_delete = ${previous}`); }
}
