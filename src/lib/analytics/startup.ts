'use client';

import { useEffect } from 'react';
import { track } from './track';

export const PRODUCT_TELEMETRY_READY_EVENT = 'o8:telemetry-consent-saved';

/** A first launch waits for persisted privacy choices instead of losing its
 * app.opened event to the initial disclosure gate. Repeated saves do not emit
 * another opening within this dashboard mount. */
export function useAppOpenedTelemetry(): void {
  useEffect(() => {
    let active = true;
    let sent = false;
    let running = false;
    let retry = false;
    const attempt = async () => {
      if (!active || sent) return;
      if (running) { retry = true; return; }
      running = true;
      do {
        retry = false;
        sent = await track('app.opened');
      } while (active && !sent && retry);
      running = false;
    };
    window.addEventListener(PRODUCT_TELEMETRY_READY_EVENT, attempt);
    void attempt();
    return () => {
      active = false;
      window.removeEventListener(PRODUCT_TELEMETRY_READY_EVENT, attempt);
    };
  }, []);
}
