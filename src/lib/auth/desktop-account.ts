import 'server-only';

import { parsePublishableKey } from '@clerk/shared/keys';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { buildNextUrl } from '@/lib/ws-server/next-fetch';
import { ChatGPTPlanError } from '@/lib/chatgpt-plan/types';
import { readSignInEpoch } from '@/lib/github-broker/managed';
import { bindVerifiedDesktopSession, readDesktopAccountEpoch, readDesktopPlanBinding } from './desktop-plan-binding';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** A loopback socket or operator token alone carries no o8 account identity. */
async function verifiedDesktopSession(request: Request): Promise<{ owner: string; sessionId: string; sourceEpoch: string | null; expectedGeneration: string | null }> {
  if (resolveRequestPrincipalContext(request).role !== 'operator') {
    throw new ChatGPTPlanError('operator_required', 'This connection is available only in the o8 desktop.', 403);
  }
  if (readAuthSignedOutAt() !== null) throw new ChatGPTPlanError('o8_sign_in_required', 'Sign in to o8 before connecting your ChatGPT plan.', 401);
  const token = request.headers.get('x-clerk-session-token');
  const sourceEpoch = readSignInEpoch();
  const expectedGeneration = readDesktopPlanBinding()?.generation ?? null;
  const key = parsePublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY);
  if (!token || !key) throw new ChatGPTPlanError('o8_sign_in_required', 'Sign in to o8 before connecting your ChatGPT plan.', 401);
  const issuer = `https://${key.frontendApi}`;
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: 5_000 }));
  try {
    const { payload } = await jwtVerify(token, keySets.get(issuer)!, {
      issuer, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nbf', 'sid'],
      ...(process.env.CLERK_JWT_AUDIENCE ? { audience: process.env.CLERK_JWT_AUDIENCE } : {}),
    });
    const local = new URL(buildNextUrl('/', undefined, 'GET'));
    const authorizedParties = new Set([
      local.origin, `${local.protocol}//localhost:${local.port}`, 'https://o8.run',
      'tauri://localhost', 'https://tauri.localhost',
      ...(process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((value) => value.trim()).filter(Boolean) ?? []),
    ]);
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.sid !== 'string'
      || (payload.aud !== undefined && !process.env.CLERK_JWT_AUDIENCE)
      || (payload.azp !== undefined && (typeof payload.azp !== 'string' || !authorizedParties.has(payload.azp)))) throw new Error();
    if (readSignInEpoch() !== sourceEpoch || readAuthSignedOutAt() !== null) throw new Error();
    return { owner: payload.sub, sessionId: payload.sid, sourceEpoch, expectedGeneration };
  } catch { throw new ChatGPTPlanError('o8_session_invalid', 'Your o8 session needs to be refreshed. Sign in again.', 401); }
}

export async function bindDesktopAccount(request: Request): Promise<void> {
  const identity = await verifiedDesktopSession(request);
  bindVerifiedDesktopSession(identity.owner, identity.sessionId, identity.sourceEpoch, identity.expectedGeneration);
}

export async function requireDesktopAccount(request: Request): Promise<string> {
  const identity = await verifiedDesktopSession(request);
  readDesktopAccountEpoch(identity.owner);
  if (readDesktopPlanBinding()?.sessionId !== identity.sessionId) throw new ChatGPTPlanError('o8_session_changed', 'The o8 session changed. Reconnect from the signed-in desktop.', 409);
  return identity.owner;
}
