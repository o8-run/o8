import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emitProductEvent, isProductTelemetryEnabled } from './server';
import { productAnalyticsDir, productSessionFile, readProductSessionMarker, writeProductSession } from './state';

let activeFile: string | null = null;
function isGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Called by the backend after successful startup. Interrupted sessions are
 * reported on the next launch; live sibling backends are left alone. */
export async function startProductSession(): Promise<void> {
  if (activeFile) return;
  try {
    const pending: boolean[] = [];
    const root = productAnalyticsDir();
    const entries = (() => { try { return readdirSync(root); } catch { return []; } })();
    for (const name of entries) {
      const match = /^session-([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid > 2147483647 || !isGone(pid)) continue;
      const source = join(root, name);
      try {
        const marker = readProductSessionMarker(source);
        if (marker.pid !== pid || typeof marker.enabled !== 'boolean') continue;
        // Only one concurrently starting backend may consume a stale marker.
        const claimed = `${source}.${randomUUID()}.claimed`;
        renameSync(source, claimed);
        rmSync(claimed);
        pending.push(marker.enabled);
      } catch { /* Missing, corrupt, or already claimed: fail closed. */ }
    }
    writeProductSession(isProductTelemetryEnabled());
    activeFile = productSessionFile();
    for (const enabled of pending) {
      if (enabled) await emitProductEvent('session.ended', { clean: false });
    }
  } catch {
    // Telemetry must not affect startup.
  }
}

/** Consume the marker before sending so repeated shutdown callbacks cannot
 * report twice. A forced shutdown is unclean; no process details leave here. */
export async function endProductSession(clean: boolean): Promise<void> {
  const marker = activeFile;
  if (!marker) return;
  activeFile = null;
  try {
    rmSync(marker, { force: true });
    await emitProductEvent('session.ended', { clean });
  } catch {
    // Telemetry must not affect shutdown.
  }
}
