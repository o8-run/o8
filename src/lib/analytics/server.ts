/**
 * Server-side coarse product telemetry. Every event is gated by the persisted
 * product consent and reduced to the explicit wire allowlist before egress.
 * This is separate from crash telemetry and user-initiated issue reports.
 */

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';

import { sanitizeProductEvent, type ProductEventName, type ProductEventProps } from './events';
import { isProductTelemetryAllowed } from './policy';
import { noteProductSessionConsent } from './state';

/**
 * #1451 local-only integration seam. That setting does not exist yet, so the
 * current runtime supplies false; once it ships its resolver belongs here.
 */
export function isProductTelemetryEnabled(): boolean {
  const { productTelemetryEnabled, telemetryConsentAnswered } = getOperatorDefaultsSync().values;
  // An on preference is staged until the privacy screen is saved. Toggling
  // off and back on must never bypass disclosure, including after a restart.
  if (!telemetryConsentAnswered) return false;
  return isProductTelemetryAllowed({
    productTelemetryEnabled: productTelemetryEnabled !== false,
    localOnlyMode: false,
  });
}

export async function emitProductEvent(
  event: ProductEventName,
  props?: ProductEventProps,
): Promise<boolean> {
  try {
    const enabled = isProductTelemetryEnabled();
    noteProductSessionConsent(enabled);
    if (!enabled) return false;

    const payload = sanitizeProductEvent(event, props);
    if (!payload) return false;

    const token = readCachedEntitlement()?.licenseKey?.trim();
    if (!token) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${proxyBaseUrl()}/v1/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never affect the app.
    return false;
  }
}
