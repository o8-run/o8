import { withAccountStateLease } from '@/lib/auth/account-state';
import { identityServiceUrl, pollDeviceLink, sessionBearerFromTicket, startDeviceLink } from '@/lib/auth/device-link';
import { deviceRequestIsLocal, deviceResponse, revokeDeviceToken } from '@/lib/auth/device-session-service';
import { writeDeviceSession } from '@/lib/auth/device-session-store';
import { writeConnectAttachEnabled } from '@/lib/connect/attach-settings';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { POST as registerMachine } from '@/app/api/panel/connect/route';
import { POST as syncEntitlement } from '@/app/api/panel/entitlement/sync/route';
import { POST as renewDevice } from '@/app/api/panel/auth/device/renew/route';
import { version } from '../../../../../../../package.json';

export const dynamic = 'force-dynamic';

/**
 * Code-based sign-in for a computer with no browser (`o8 connect --sign-in`).
 *
 *   start → the account service issues a short code for a person to approve.
 *   poll  → once approved, this computer stores its device session, renews it
 *           for a sign-in ticket, trades the ticket for an account session,
 *           syncs the account's licence, registers the machine and turns its
 *           account link on.
 *
 * Every later step reuses the route the desktop app already uses, so the
 * account-state leases and checks stay in one place.
 */

let finishing: Promise<Response> | null = null;

function local(request: Request, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  // Carry the caller's headers, so each reused route sees the same loopback
  // operator request this one was admitted with.
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
  return new Request(new URL(path, request.url), {
    method: 'POST', headers, body: JSON.stringify(init.body ?? {}),
  });
}

async function finish(request: Request): Promise<Response> {
  const poll = await pollDeviceLink();
  if (poll.status !== 'approved') return deviceResponse({ ok: true, status: poll.status });

  // The override serves tests and self-hosted identity services.
  const identityUrl = process.env.O8_IDENTITY_URL?.trim().replace(/\/+$/, '') || identityServiceUrl(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
  );
  // Until the credential is stored it is a live grant nobody holds: revoke it.
  // Once stored it may have rotated, and a stale credential must never be sent
  // to revoke, where it reads as reuse. The stored session is then left for the
  // next attempt to replace.
  let stored = false;
  const fail = async (reason: string) => {
    if (!stored) await revokeDeviceToken(poll.deviceToken);
    return deviceResponse({ ok: false, status: 'failed', reason }, 502);
  };
  if (!identityUrl) return fail('sign_in_unavailable');

  // Retire an earlier explicit sign-out before any account write.
  const cleared = await syncEntitlement(local(request, '/api/panel/entitlement/sync', { body: { clearSignInMarker: true } }));
  if (!cleared.ok) return fail('sign_in_unavailable');
  await withAccountStateLease(() => {
    writeDeviceSession({
      token: poll.deviceToken, clerkUserId: poll.clerkUserId,
      installId: poll.installId, idleExpiresAt: poll.idleExpiresAt,
    });
  });
  stored = true;

  const renewed = await renewDevice(local(request, '/api/panel/auth/device/renew'));
  const grant = await renewed.json().catch(() => null) as { ticket?: unknown; clerkUserId?: unknown } | null;
  if (!renewed.ok || typeof grant?.ticket !== 'string' || grant.clerkUserId !== poll.clerkUserId) {
    return fail('device_renew_failed');
  }
  const bearer = await sessionBearerFromTicket(identityUrl, grant.ticket).catch(() => null);
  if (!bearer) return fail('ticket_exchange_failed');

  const synced = await syncEntitlement(local(request, '/api/panel/entitlement/sync', {
    body: { clerkUserId: poll.clerkUserId }, headers: { 'x-clerk-session-token': bearer },
  }));
  const account = await synced.json().catch(() => null) as { ok?: unknown; plan?: unknown; reason?: unknown } | null;
  if (!synced.ok || account?.ok !== true) {
    return fail(typeof account?.reason === 'string' ? account.reason : 'account_sync_failed');
  }

  // Joining the account's machines is what makes this computer reachable.
  const registered = await registerMachine(local(request, '/api/panel/connect', { headers: { 'x-clerk-session-token': bearer } }));
  const machine = await registered.json().catch(() => null) as { ok?: unknown; machineId?: unknown; error?: { code?: unknown } } | null;
  const connected = registered.ok && machine?.ok === true;
  if (connected) writeConnectAttachEnabled(true);
  return deviceResponse({
    ok: true, status: 'signed-in', plan: typeof account.plan === 'string' ? account.plan : null,
    connected, machineId: connected && typeof machine?.machineId === 'string' ? machine.machineId : null,
    connectError: connected ? null : (typeof machine?.error?.code === 'string' ? machine.error.code : 'connect_failed'),
  });
}

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  const body = await request.clone().json().catch(() => null) as { action?: unknown } | null;
  try {
    if (body?.action === 'start') {
      const offer = await startDeviceLink({ installId: getOrCreateInstallId(), appVersion: version });
      return offer
        ? deviceResponse({ ok: true, ...offer })
        : deviceResponse({ ok: false, reason: 'link_unavailable' }, 503);
    }
    if (body?.action === 'poll') {
      // One completion at a time: an approval is read from the service once.
      if (!finishing) finishing = finish(request).finally(() => { finishing = null; });
      return (await finishing).clone();
    }
    return deviceResponse({ ok: false, reason: 'invalid_action' }, 400);
  } catch {
    return deviceResponse({ ok: false, reason: 'link_unavailable' }, 503);
  }
}
