import { NextResponse } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { findUserByClerkId } from '@/lib/db/users';
import { readActiveIdentity } from '@/lib/github-broker/managed';

export const dynamic = 'force-dynamic';

const AVATAR_HOSTS = new Set(['avatars.githubusercontent.com', 'img.clerk.com']);
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_LIMIT = 2 * 1024 * 1024;

function noPhoto(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * A GitHub device sign-in leaves the local row without a Clerk id, so the only
 * local account stands in for an identity that matches no row.
 */
function accountPhoto(identity: string): string | null {
  const direct = findUserByClerkId(identity);
  if (direct) return direct.avatarUrl;
  const rows = getDb()?.select({ avatarUrl: users.avatarUrl }).from(users).limit(2).all() ?? [];
  return rows.length === 1 ? rows[0].avatarUrl : null;
}

/** The stored URL comes from the renderer, so only known photo hosts are fetched. */
function photoUrl(stored: string | null | undefined): URL | null {
  if (!stored) return null;
  try {
    const url = new URL(stored);
    return url.protocol === 'https:' && AVATAR_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/panel/account/avatar — the signed-in account's photo, for the native
 * rail, which has no TLS client of its own. 204 means show the account icon.
 */
export async function GET(request: Request) {
  try {
    if (resolveRequestPrincipalContext(request).role !== 'operator') {
      return NextResponse.json({ error: 'operator_required' }, { status: 403 });
    }
    if (readAuthSignedOutAt() !== null) return noPhoto();
    const identity = readActiveIdentity();
    const url = photoUrl(identity ? accountPhoto(identity) : null);
    if (!url) return noPhoto();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !AVATAR_TYPES.has(type)) return noPhoto();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_LIMIT) return noPhoto();
    return new NextResponse(bytes, {
      headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' },
    });
  } catch {
    return noPhoto();
  }
}
