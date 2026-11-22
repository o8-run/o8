import { SELF_REQUEST_HEADERS } from '@/lib/background-work/idle-gate';
import { getApiBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const runtime = globalThis as typeof globalThis & { __o8NextStartupScheduled?: boolean };

/** Give the document and hydration priority before optional background imports. */
export function scheduleNextServerStartup(): void {
  if (runtime.__o8NextStartupScheduled) return;
  runtime.__o8NextStartupScheduled = true;

  const attempt = async () => {
    try {
      const origin = getApiBase();
      // Boot work is the server's own: neither request is client activity for the idle gate.
      const health = await fetch(`${origin}/api/panel/status`, { headers: SELF_REQUEST_HEADERS, signal: AbortSignal.timeout(1_500) });
      if (!health.ok || (await health.json()).product !== 'o8') throw new Error('not ready');
      const response = await fetch(`${origin}/api/review/auto-review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json', ...SELF_REQUEST_HEADERS },
        body: JSON.stringify({ action: 'bootstrap' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The listener or its lazy route may still be starting. Retry locally;
      // never let optional boot work reject the instrumentation hook.
    }
    setTimeout(() => { void attempt(); }, 1_000).unref?.();
  };
  // Health can finish while the loader is navigating. Importing telemetry,
  // transcript repair and indexers immediately then competes with the document
  // on this same Node thread. A bounded grace period also preserves automatic
  // initialization for headless servers that never open a dashboard.
  setTimeout(() => { void attempt(); }, 2_000).unref?.();
}
