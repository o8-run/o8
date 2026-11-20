import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import vectors from './fixtures/composer-queue/v1.8-vectors.json';
import mixedPrefix from './fixtures/composer-queue/v1.12-vectors.json';
import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import { composerWsIdentity, encodeComposerIdentity, resolveComposerWireThreadId } from '@/lib/ws-server/composer-ws-identity';
import { COMPOSER_RPC_PENDING_LIMIT, ComposerOwnerRequests, ComposerOwnerUnknownOutcome } from '@/lib/ws-server/composer-owner-rpc';

it.each(vectors.idVectors)('matches the locked v1.8 bytes for $name', vector => {
  const { repoKey, wireThreadId, clientMutationId } = vector.input;
  const threadId = resolveComposerWireThreadId(wireThreadId);
  expect(threadId).toBe(vector.resolvedThreadId);
  expect(encodeComposerIdentity(['o8.cq.ws-id.v1', repoKey, threadId, clientMutationId]).toString('hex')).toBe(vector.encodedIdInputHex);
  const keys = composerWsIdentity(repoKey, wireThreadId, clientMutationId);
  expect(keys).toEqual({ id: vector.wsId, syntheticThreadId: vector.wsiTarget });
  expect(keys.id).toHaveLength(46);
  expect(keys.syntheticThreadId).toHaveLength(47);
});
it('rejects ill-formed identity strings and hashes the exact original ingress bytes', () => {
  expect(() => encodeComposerIdentity(['\ud800'])).toThrow('Invalid composer identity');
  expect(Buffer.byteLength(vectors.ingress.wireJson)).toBe(vectors.ingress.wireJsonUtf8Bytes);
  expect(createHash('sha256').update(vectors.ingress.wireJson).digest('hex')).toBe(vectors.ingress.ingressHash);
});

function fixture() {
  const sent: Array<{ epoch: string; requestId: string }> = [];
  const client = new ComposerOwnerRequests(line => sent.push(JSON.parse(line)));
  client.attach('opaque-owner-generation');
  const reply = (index: number, result: unknown, epoch = sent[index].epoch) => client.receive({
    v: 1, kind: 'composer-queue-response', epoch, requestId: sent[index].requestId, ok: true, result,
  });
  return { client, sent, reply };
}
it('correlates out-of-order replies and keeps the attempt token verbatim', async () => {
  const { client, sent, reply } = fixture();
  const first = client.request('admit', { id: 'send-one', claimToken: 'abcdefghijklmnopqrstuv' });
  const second = client.request('assertClaim', { id: 'send-two', claimToken: 'ABCDEFGHIJKLMNOPQRSTUV' });
  expect(sent[0]).toMatchObject({ params: { id: 'send-one', claimToken: 'abcdefghijklmnopqrstuv' } });
  reply(1, { live: false }); reply(0, { changed: true });
  expect(await second).toEqual({ live: false }); expect(await first).toEqual({ changed: true });
});
it('fails closed at 32 pending requests without sending the overflow', async () => {
  const { client, sent } = fixture();
  const calls = Array.from({ length: COMPOSER_RPC_PENDING_LIMIT }, () => client.request('listTargets', {}).catch(error => error));
  await expect(client.request('listTargets', {})).rejects.toMatchObject({ code: 'unavailable' });
  expect(sent).toHaveLength(COMPOSER_RPC_PENDING_LIMIT);
  client.disconnect();
  expect((await Promise.all(calls)).every(error => error instanceof ComposerOwnerUnknownOutcome)).toBe(true);
});
it('times out at five seconds, never retries, and discards the late response', async () => {
  vi.useFakeTimers();
  const { client, sent, reply } = fixture();
  try {
    const call = client.request('admit', { id: 'send-one', claimToken: 'abcdefghijklmnopqrstuv' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await call).toBeInstanceOf(ComposerOwnerUnknownOutcome);
    expect(sent).toHaveLength(1);
    expect(reply(0, { changed: true })).toBe(true);
    expect(sent).toHaveLength(1);
  } finally { client.disconnect(); vi.useRealTimers(); }
});
it.each([{ changed: 'true' }, { live: true }, null])('rejects a malformed admission receipt %j', async result => {
  const { client, reply } = fixture();
  const call = client.request('admit', { id: 'send-one', claimToken: 'abcdefghijklmnopqrstuv' }).catch(error => error);
  expect(() => reply(0, result)).toThrow('Invalid composer owner result');
  client.disconnect(); expect(await call).toBeInstanceOf(ComposerOwnerUnknownOutcome);
});
it('does not accept a response from another opaque epoch', async () => {
  const { client, reply } = fixture();
  const call = client.request('admit', { id: 'send-one', claimToken: 'abcdefghijklmnopqrstuv' }).catch(error => error);
  expect(() => reply(0, { changed: true }, 'other-owner-generation')).toThrow('Stale composer owner response');
  client.disconnect(); expect(await call).toBeInstanceOf(ComposerOwnerUnknownOutcome);
});

it('matches the v1.12 mixed-case prefix vector while retaining the exact original wire digest', () => {
  const wire = JSON.parse(mixedPrefix.wireJson);
  expect(validateComposerImageAttachments(wire.attachments)[0].dataUri).toBe(mixedPrefix.canonicalDataUri);
  expect(createHash('sha256').update(mixedPrefix.wireJson).digest('hex')).toBe(mixedPrefix.ingressHash);
  const reference = mixedPrefix.ingressJsonValue.attachments[0].dataUri;
  expect(reference).toEqual({ payloadImageIndex: 0, dataUriPrefix: 'DATA:image/PNG;Base64,' });
  expect(Buffer.byteLength(reference.dataUriPrefix)).toBeLessThanOrEqual(128);
  expect(reference.dataUriPrefix.toLowerCase()).toBe('data:image/png;base64,');
  expect(reference.dataUriPrefix + mixedPrefix.canonicalDataUri.split(',')[1]).toBe(wire.attachments[0].dataUri);
});
