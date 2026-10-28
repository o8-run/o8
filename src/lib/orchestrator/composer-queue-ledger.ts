import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { persistComposerImages } from '@/lib/mobile/orchestrator-image-media';
import type { ComposerQueuePayload } from './composer-queue-types';

export const composerPayloadHash = (serialized: string): string => createHash('sha256').update(serialized).digest('hex');

/** Keep audit context and applied steer text for older transcript readers. */
export function compactComposerPayload(serialized: string, preserveSteer = false): string {
  const payload = JSON.parse(serialized) as ComposerQueuePayload;
  // Older transcript readers need payload.text; wireMessage is only for dispatch.
  // Older steers used the ledger as their only media reference. Keep small
  // content-addressed transcript references, never inline screenshot bytes.
  const deliveredMedia = preserveSteer && payload.images.length ? persistComposerImages(payload.images) : undefined;
  return JSON.stringify({ ...payload, text: preserveSteer ? payload.text : '', wireMessage: '', images: [], ...(deliveredMedia ? { deliveredMedia } : {}) });
}

/** Clear freed overflow pages too; keep the connection's existing policy. */
export function withComposerPayloadRemoval<T>(sqlite: Database.Database, write: () => T): T {
  const previous = sqlite.pragma('secure_delete', { simple: true }) as number;
  sqlite.pragma('secure_delete = ON');
  try { return write(); } finally { sqlite.pragma(`secure_delete = ${previous}`); }
}
