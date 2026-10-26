'use client';

/**
 * Browser product telemetry. Consent is read from the server-owned operator
 * defaults before every event, and the POST is gated again on the server.
 * The legacy localStorage opt-out key is intentionally ignored: neither its
 * absence nor any other browser-only state can override the persisted choice.
 */

import {
  sanitizeProductEvent,
  type ProductEventName,
  type ProductEventProps,
  type ProductEventPayload,
} from './events';

async function sendIfEnabled(payload: ProductEventPayload): Promise<boolean> {
  const consentResponse = await fetch('/api/panel/telemetry', {
    method: 'GET',
    cache: 'no-store',
  });
  if (!consentResponse.ok) return false;

  const consent = (await consentResponse.json().catch(() => null)) as { enabled?: unknown } | null;
  if (consent?.enabled !== true) return false;

  const response = await fetch('/api/panel/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  });
  const result = await response.json().catch(() => null) as { emitted?: unknown } | null;
  return response.ok && result?.emitted === true;
}

export function track(event: ProductEventName, props?: ProductEventProps): Promise<boolean> {
  try {
    if (typeof window === 'undefined') return Promise.resolve(false);
    const payload = sanitizeProductEvent(event, props);
    if (!payload) return Promise.resolve(false);
    return sendIfEnabled(payload).catch(() => false);
  } catch {
    // Telemetry must never affect the app.
    return Promise.resolve(false);
  }
}
