// Moved from src/app/api/panel/entitlement/sync/route.ts so callers outside Next
// do not bundle Clerk's server helpers.
import { NextResponse } from 'next/server';
import { AccountStateUnavailableError, accountRefreshIsBlocked, allowAccountRefresh, captureAccountGeneration,
  currentAccountGeneration, holdAccountRefresh, invalidateAccountState,
  publishReadyAccountState, requireAccountGeneration, withAccountStateLease,
  withPreservedAccountState } from '@/lib/auth/account-state';
import { clearAuthSignOutMarker, markAuthSignedOut, readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { clearFounderRecord, writeFounderRecord } from '@/lib/entitlement/founder';
import { tokenIssuedAt } from '@/lib/entitlement/identity-guards';
import { clearCachedAccountEntitlement, verifyLicense, writeCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlement } from '@/lib/entitlement/store';
import { bumpSignInEpoch, clearActiveIdentity, clearManagedGithubState, readActiveIdentity,
  readManagedGithubState, readSignInEpoch, writeActiveIdentity, writeManagedGithubState } from '@/lib/github-broker/managed';

const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY);
interface AccountLicenseResponse {
  license?: unknown; source?: unknown;
  founder?: { operatorNumber?: unknown; tier?: unknown };
}
interface SyncBody { signedOut?: unknown; clerkUserId?: unknown; clearSignInMarker?: unknown }

/** Network work stays outside the lease; success and rejection cleanup share its generation fence. */
async function syncManagedGithubApp(sessionToken: string, generation: string): Promise<void> {
  try {
    const res = await fetch(`${proxyBaseUrl()}/github/app/token`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status === 403 || res.status === 503) {
      await withPreservedAccountState(() => { requireAccountGeneration(generation); clearManagedGithubState(); });
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as {
      installed?: boolean; token?: string; expiresAt?: string; installationId?: number;
      accountLogin?: string; installUrl?: string; ownerClerkUserId?: string;
    };
    const owner = typeof data.ownerClerkUserId === 'string' ? data.ownerClerkUserId.trim() : '';
    if (!owner) return;
    await withPreservedAccountState(() => {
      requireAccountGeneration(generation);
      // An old token cannot activate a signed-out desktop, even if its iat equals sign-out.
      if (accountRefreshIsBlocked() || readAuthSignedOutAt() !== null) throw new AccountStateUnavailableError();
      const active = readActiveIdentity();
      if (active !== owner) throw new AccountStateUnavailableError();
      const priorOwner = readManagedGithubState()?.ownerClerkUserId;
      if (priorOwner && priorOwner !== owner) clearManagedGithubState();
      if (data.installed === true && data.token && data.expiresAt && data.installationId) {
        writeManagedGithubState({ installed: true, token: data.token, expiresAt: data.expiresAt,
          installationId: data.installationId, accountLogin: data.accountLogin, ownerClerkUserId: owner });
      } else if (data.installed === false) {
        writeManagedGithubState({ installed: false, installUrl: data.installUrl, ownerClerkUserId: owner });
      }
    });
  } catch { console.warn('[entitlement] managed GitHub App sync skipped'); }
}

function clearAccountFiles(): void {
  invalidateAccountState();
  clearCachedAccountEntitlement();
  clearFounderRecord();
  clearManagedGithubState();
  clearActiveIdentity();
}
async function clearedResponse(reason: string, status: number) {
  const entitlement = await getEntitlement();
  return NextResponse.json({ ok: false, reason, plan: entitlement.plan, source: entitlement.source }, { status });
}
function stale(sessionToken: string): boolean {
  const signedOutAt = readAuthSignedOutAt();
  const iat = tokenIssuedAt(sessionToken);
  return signedOutAt !== null && iat !== null && iat < signedOutAt;
}

/** Loopback/operator-gated. Only the hosted service and signed license verify account identity. */
/** Clerk's cookie session, when the caller runs inside Next; absent elsewhere. */
export type SessionResolver = () => Promise<string | null>;

/**
 * Account sync shared by the Next route and in-process callers (device-link).
 * Without a resolver only the forwarded `x-clerk-session-token` is used, as when
 * Clerk's request context is unavailable.
 */
export async function syncEntitlement(request: Request, resolveSession?: SessionResolver) {
  if (!CLERK_ENABLED) return NextResponse.json({ ok: false, reason: 'clerk_disabled' });
  try {
    const body = await request.json().catch(() => null) as SyncBody | null;
    if (body?.signedOut === true) {
      await withAccountStateLease(() => { markAuthSignedOut(); bumpSignInEpoch(); clearAccountFiles(); });
      return clearedResponse('signed_out', 200);
    }
    if (body?.clearSignInMarker === true) {
      await withAccountStateLease(() => {
        holdAccountRefresh();
        clearAuthSignOutMarker(); bumpSignInEpoch(); clearManagedGithubState(); clearActiveIdentity();
        allowAccountRefresh();
      });
      return NextResponse.json({ ok: true });
    }
    // Capture before any asynchronous auth or service lookup. Never adopt a newer generation on completion.
    const generation = await captureAccountGeneration();
    const activeClerkUserId = typeof body?.clerkUserId === 'string' ? body.clerkUserId.trim() : '';
    let sessionToken: string | null = null;
    try {
      sessionToken = (await resolveSession?.()) ?? null;
    } catch { /* Native mode forwards its short-lived session instead of cookies. */ }
    sessionToken ||= request.headers.get('x-clerk-session-token')?.trim() || null;
    if (!sessionToken) return NextResponse.json({ ok: false, reason: 'no_session' }, { status: 401 });
    const credential = sessionToken;
    const initiallyStale = await withAccountStateLease(() => {
      requireAccountGeneration(generation);
      if (accountRefreshIsBlocked()) return true;
      if (!stale(credential)) return false;
      clearAccountFiles();
      return true;
    });
    if (initiallyStale) return clearedResponse('stale_session', 401);
    try {
      void fetch(`${proxyBaseUrl()}/account/link-install`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: getOrCreateInstallId() }),
      }).catch(() => {});
    } catch { /* Analytics linking never determines account admission. */ }
    const res = await fetch(`${proxyBaseUrl()}/account/license`, {
      method: 'POST', headers: { Authorization: `Bearer ${credential}` },
    });
    if (res.status === 404) {
      const committedGeneration = await withAccountStateLease(() => {
        requireAccountGeneration(generation);
        if (accountRefreshIsBlocked()) throw new AccountStateUnavailableError();
        clearAuthSignOutMarker(); clearCachedAccountEntitlement(); clearFounderRecord();
        return currentAccountGeneration();
      });
      void syncManagedGithubApp(credential, committedGeneration);
      const entitlement = await getEntitlement();
      return NextResponse.json({ ok: true, plan: entitlement.plan, source: entitlement.source });
    }
    if (!res.ok) return NextResponse.json({ ok: false, reason: `license_server_${res.status}` });
    const data = (await res.json()) as AccountLicenseResponse;
    const license = typeof data.license === 'string' ? data.license : '';
    if (!license) return NextResponse.json({ ok: false, reason: 'no_license_in_response' });
    const verified = await verifyLicense(license, { offlineGrace: false });
    if (!verified.valid || !verified.plan) return NextResponse.json({ ok: false, reason: verified.reason ?? 'invalid_license' });
    let committedGeneration = '';
    const outcome = await withAccountStateLease(() => {
      requireAccountGeneration(generation);
      if (!activeClerkUserId || verified.subject !== activeClerkUserId) {
        clearAccountFiles(); return 'license_subject_mismatch';
      }
      if (accountRefreshIsBlocked() || stale(credential)) { clearAccountFiles(); return 'stale_session'; }
      writeActiveIdentity(verified.subject);
      if (!readSignInEpoch()) bumpSignInEpoch();
      if (!writeCachedEntitlement({ plan: verified.plan!, status: 'active', expiresAt: verified.expiresAt, licenseKey: license })) {
        throw new AccountStateUnavailableError();
      }
      clearAuthSignOutMarker();
      const founder = data.founder;
      if (founder && typeof founder.operatorNumber === 'number') {
        if (!writeFounderRecord({ operatorNumber: founder.operatorNumber,
          tier: typeof founder.tier === 'number' ? founder.tier : null, syncedAt: new Date().toISOString() })) {
          throw new AccountStateUnavailableError();
        }
      } else clearFounderRecord();
      publishReadyAccountState(verified.subject, readSignInEpoch()!, license);
      committedGeneration = currentAccountGeneration();
      return 'ready';
    });
    if (outcome !== 'ready') return clearedResponse(outcome, outcome === 'stale_session' ? 401 : 409);
    void syncManagedGithubApp(credential, committedGeneration);
    const entitlement = await getEntitlement();
    return NextResponse.json({ ok: true, plan: entitlement.plan,
      source: typeof data.source === 'string' ? data.source : 'subscription' });
  } catch (error) {
    const changed = error instanceof AccountStateUnavailableError;
    if (!changed) console.error('[entitlement] sync failed');
    return NextResponse.json({ ok: false, reason: changed ? 'account_state_changed' : 'error' }, { status: changed ? 409 : 200 });
  }
}
