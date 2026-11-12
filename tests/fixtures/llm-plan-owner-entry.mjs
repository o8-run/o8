// Real account verification and plan cancellation, with isolated issuer and OS-store IO.
import '../../scripts/register-server-only-stub.mjs';
import 'tsx';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const storeModule = await import('../../src/lib/chatgpt-plan/credential-store.ts');
const { OsPlanStore } = storeModule.default ?? storeModule;
const typesModule = await import('../../src/lib/chatgpt-plan/types.ts');
const { PLAN_SCOPE } = typesModule.default ?? typesModule;
const directory = process.env.CORTEX_IDE_DATA_DIR;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
const issuer = 'https://owner-fixture.clerk.accounts.dev';
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('owner-fixture.clerk.accounts.dev$').toString('base64')}`;
const jwt = await new SignJWT({ sid: 'fixture-session' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
  .setIssuer(issuer).setSubject('fixture-owner').setIssuedAt().setNotBefore('0s').setExpirationTime('1h').sign(privateKey);
writeFileSync(join(directory, 'fixture-session'), jwt);
writeFileSync(join(directory, 'chatgpt-desktop-account.json'), JSON.stringify({ owner: 'fixture-owner', sessionId: 'fixture-session', sourceEpoch: null, generation: 'fixture-epoch' }));
let record = { owner: 'fixture-owner', generation: 1, activeId: 'fixture-account', welcomed: true,
  registrations: [{ id: 'fixture-account', issuer: 'https://auth.openai.com', subject: 'fixture-subject', clientId: 'fixture-client', label: 'Fixture',
    tokens: { accessToken: 'plan-fixture-secret', refreshToken: 'plan-refresh-secret', idToken: 'fixture-id', expiresAt: Date.now() + 3600000, scopes: [PLAN_SCOPE] } }] };
OsPlanStore.prototype.locked = async function (_owner, action) { return action(); };
OsPlanStore.prototype.read = async function () { return structuredClone(record); };
OsPlanStore.prototype.write = async function (_owner, value) { record = structuredClone(value); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const value = String(url);
  if (value === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
  if (value === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', visibility: 'list' }] });
  if (value === 'https://auth.openai.com/api/accounts/oauth/revoke') return Response.json({});
  if (value === 'https://api.openai.com/v1/responses') return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"first"}\n\n'));
      init.signal.addEventListener('abort', () => controller.error(new Error('Fixture stream cancelled')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  return realFetch(url, init);
};
const workerModule = await import('../../src/lib/auth/packet-worker-token.ts');
const { mintPacketWorkerToken } = workerModule.default ?? workerModule;
writeFileSync(join(directory, 'fixture-packet-worker'), mintPacketWorkerToken('fixture-packet'));
await import('../../src/ws-server.ts');
