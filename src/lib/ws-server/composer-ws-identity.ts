import { createHash } from 'node:crypto';

/** Byte-pinned v1.8 identity; null and empty strings are different encodings. */
export function encodeComposerIdentity(fields: Array<string | null>): Buffer {
  return Buffer.concat(fields.map(value => {
    if (value === null) return Buffer.from([0]);
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.toString('utf8') !== value) throw new Error('Invalid composer identity string.');
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([prefix, bytes]);
  }));
}
export function resolveComposerWireThreadId(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.startsWith('thoughts-') ? trimmed : null;
}
export function composerWsIdentity(repoKey: string, wireThreadId: unknown, clientMutationId: string) {
  const threadId = resolveComposerWireThreadId(wireThreadId);
  const hash = (domain: string) => createHash('sha256').update(encodeComposerIdentity([domain, repoKey, threadId, clientMutationId])).digest('base64url');
  return { id: `ws-${hash('o8.cq.ws-id.v1')}`, syntheticThreadId: `wsi:${hash('o8.cq.wsi-target.v1')}` };
}
