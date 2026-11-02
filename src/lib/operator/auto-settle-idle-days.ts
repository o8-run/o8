/** `[inbox] auto_settle_idle_days`: whole days, 0 (off) to a year. */
export function isAutoSettleIdleDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365;
}
