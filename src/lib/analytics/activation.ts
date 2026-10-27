import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { productAnalyticsDir } from './state';
import { emitProductEvent, isProductTelemetryEnabled } from './server';

/** Atomic, installation-local claims survive restarts and simultaneous launches.
 * Off activity is neither persisted nor queued for later delivery.
 * Delivery is best effort; a lost request does not repeat the first step. */
export async function recordProductMilestone(event: 'worker.first_launched' | 'merge.first_completed'): Promise<boolean> {
  try {
    if (!isProductTelemetryEnabled()) return false;
    mkdirSync(productAnalyticsDir(), { recursive: true });
    writeFileSync(join(productAnalyticsDir(), event), '', { flag: 'wx', mode: 0o600 });
    return await emitProductEvent(event);
  } catch {
    return false;
  }
}
