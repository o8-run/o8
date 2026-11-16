import 'server-only';

import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

/**
 * Code-based sign-in for a computer with no browser. The computer asks the
 * account service for a short code, a signed-in person approves it on the
 * verification page, and the computer becomes an ordinary device session.
 *
 * The one-time secret stays in this process. The device credential is derived
 * from it here, so the credential is never sent to this computer.
 */

export interface DeviceLinkOffer {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

interface PendingLink extends DeviceLinkOffer {
  secret: string;
  installId: string;
}

export type DeviceLinkPoll =
  | { status: 'none' | 'pending' | 'expired' }
  | { status: 'approved'; deviceToken: string; clerkUserId: string; installId: string; idleExpiresAt: string };

let pending: PendingLink | null = null;

/** The device credential this computer derives from its one-time secret. */
export function deviceTokenFromLinkSecret(secret: string): string {
  return `o8d_${createHmac('sha256', secret).update('o8-device-link-v1').digest('base64url')}`;
}

/** The identity service host named by the publishable key, or null. */
export function identityServiceUrl(publishableKey: string | undefined): string | null {
  const encoded = /^pk_(?:live|test)_(.+)$/.exec(publishableKey?.trim() ?? '')?.[1];
  if (!encoded) return null;
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '');
  return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
}

function linkRequest(path: string, body: unknown): Promise<Response> {
  return fetch(`${proxyBaseUrl()}/account/device/link${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

export async function startDeviceLink(input: {
  installId: string;
  appVersion: string;
}): Promise<DeviceLinkOffer | null> {
  const response = await linkRequest('', {
    installId: input.installId, name: hostname().slice(0, 128), platform: process.platform, appVersion: input.appVersion,
  });
  if (!response.ok) return null;
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.deviceCode !== 'string' || typeof data.userCode !== 'string'
    || typeof data.verificationUrl !== 'string' || typeof data.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(data.expiresAt))) return null;
  const offer: DeviceLinkOffer = {
    userCode: data.userCode,
    verificationUrl: data.verificationUrl,
    expiresAt: data.expiresAt,
    interval: typeof data.interval === 'number' && data.interval >= 1 && data.interval <= 60 ? data.interval : 5,
  };
  pending = { ...offer, secret: data.deviceCode, installId: input.installId };
  return offer;
}

/** Ask whether the pending code was approved. An approval is returned once. */
export async function pollDeviceLink(now = Date.now()): Promise<DeviceLinkPoll> {
  const current = pending;
  if (!current) return { status: 'none' };
  if (Date.parse(current.expiresAt) <= now) {
    pending = null;
    return { status: 'expired' };
  }
  const response = await linkRequest('/poll', { deviceCode: current.secret, installId: current.installId });
  if (response.status === 404) {
    if (pending === current) pending = null;
    return { status: 'expired' };
  }
  if (!response.ok) return { status: 'pending' };
  const data = await response.json() as Record<string, unknown>;
  if (data.status !== 'approved' || typeof data.clerkUserId !== 'string' || !data.clerkUserId.trim()
    || typeof data.idleExpiresAt !== 'string' || !Number.isFinite(Date.parse(data.idleExpiresAt))) {
    return { status: 'pending' };
  }
  if (pending === current) pending = null;
  return {
    status: 'approved', deviceToken: deviceTokenFromLinkSecret(current.secret),
    clerkUserId: data.clerkUserId, installId: current.installId, idleExpiresAt: data.idleExpiresAt,
  };
}

/** Trade a one-time sign-in ticket for a short-lived account session bearer. */
export async function sessionBearerFromTicket(identityUrl: string, ticket: string): Promise<string | null> {
  const response = await fetch(`${identityUrl}/v1/client/sign_ins?_is_native=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `strategy=ticket&ticket=${encodeURIComponent(ticket)}`,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const data = await response.json() as {
    response?: { status?: string; created_session_id?: string };
    client?: { sessions?: { id?: string; last_active_token?: { jwt?: string } }[] };
  };
  const sessionId = data.response?.created_session_id;
  if (data.response?.status !== 'complete' || !sessionId) return null;
  return data.client?.sessions?.find((entry) => entry.id === sessionId)?.last_active_token?.jwt ?? null;
}

export function resetDeviceLinkForTests(): void {
  pending = null;
}
