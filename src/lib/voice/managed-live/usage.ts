/** Voice-layer estimate from the API-key probe on 2026-09-10, not a tariff guarantee. */
export const GPT_LIVE_RATE_FROM_2166_PROBE = {
  usdPerMinute: 0.05,
  source: 'https://github.com/o8-run/o8/issues/2166',
} as const;

export function formatGptLiveUsage(seconds: number): string {
  const elapsed = Math.floor(Math.max(0, seconds));
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} · Est. $${(Math.max(0, seconds) / 60 * GPT_LIVE_RATE_FROM_2166_PROBE.usdPerMinute).toFixed(2)}`;
}
