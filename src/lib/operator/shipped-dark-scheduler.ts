import 'server-only';
import { auditShippedButDarkFlags, type ShippedButDarkAudit } from './shipped-dark-audit';
import { recordShippedDarkAudit, type ShippedDarkAuditReceipt } from './shipped-dark-receipt';
import { recurring } from '@/lib/background-work/ledger';
export { SHIPPED_DARK_WARNING_RELEASES, recordShippedDarkAudit, readShippedDarkAuditReceipt, currentShippedDarkAuditStatus } from './shipped-dark-receipt';
export type { ShippedDarkAuditReceipt, ShippedDarkFlagStatus, ShippedDarkAuditStatus } from './shipped-dark-receipt';

export const SHIPPED_DARK_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runShippedDarkAudit(options: {
  now?: Date;
  audit?: () => Promise<ShippedButDarkAudit>;
} = {}): Promise<ShippedDarkAuditReceipt> {
  const audit = await (options.audit ?? auditShippedButDarkFlags)();
  return recordShippedDarkAudit(audit, (options.now ?? new Date()).toISOString());
}

let bootHookFired = false;
let tickHandle: ReturnType<typeof setInterval> | null = null;

function runScheduledAudit(
  reason: 'boot' | 'tick',
  run: () => Promise<ShippedDarkAuditReceipt>,
): void {
  void run().catch((error: unknown) => {
    console.warn(
      `[shipped-dark-audit] ${reason} check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

/** Start one immediate installed-runtime audit and repeat it every 24 hours. */
export function ensureShippedDarkAuditBootHook(options: {
  run?: () => Promise<ShippedDarkAuditReceipt>;
} = {}): void {
  if (bootHookFired) return;
  bootHookFired = true;
  const run = options.run ?? runShippedDarkAudit;
  setImmediate(() => runScheduledAudit('boot', run));
  if (tickHandle) return;
  tickHandle = recurring('shipped-dark-audit', 
    () => runScheduledAudit('tick', run),
    SHIPPED_DARK_AUDIT_INTERVAL_MS,
  );
  if (typeof tickHandle.unref === 'function') tickHandle.unref();
}
