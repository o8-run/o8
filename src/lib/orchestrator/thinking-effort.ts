// 'ultra' is a Codex flagship reasoning tier (internal sub-agent fan-out, heavy
// token burn). It is a valid app effort but is clamped to 'xhigh' by the Codex
// effort resolver for other models, and mapped down for Claude.
export type ThinkingEffort = 'adaptive' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'ultra';

/** Whether an effort value describes provider reasoning or a different runtime contract. */
export type EffortReceiptSource = 'transport' | 'runtime-default' | 'service-tier';

export function isEffortReceiptSource(value: unknown): value is EffortReceiptSource {
  return value === 'transport' || value === 'runtime-default' || value === 'service-tier';
}

/** Managed inference tier, separate from provider reasoning effort. */
export type LeadServiceTier = 'low' | 'high';
export function isLeadServiceTier(value: unknown): value is LeadServiceTier {
  return value === 'low' || value === 'high';
}

export type ManualThinkingEffort = Exclude<ThinkingEffort, 'adaptive'>;

export const THINKING_EFFORTS: ThinkingEffort[] = ['adaptive', 'none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'];
export const MANUAL_THINKING_EFFORTS: ManualThinkingEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'];

export interface ThinkingEffortLabel {
  long: string;
  short: string;
  detail: string;
}

/**
 * Shared operator-facing vocabulary for every thinking-effort control. The
 * persisted effort keys stay in `ThinkingEffort`; only their presentation
 * belongs here.
 */
export const THINKING_EFFORT_LABELS: Record<ThinkingEffort, ThinkingEffortLabel> = {
  adaptive: { long: 'Adaptive', short: 'adaptive', detail: 'Adaptive · the model picks' },
  none: { long: 'None', short: 'none', detail: 'None · no reasoning' },
  minimal: { long: 'Minimal', short: 'minimal', detail: 'Minimal · lightest reasoning' },
  low: { long: 'Low', short: 'low', detail: 'Low · fast, cheapest' },
  medium: { long: 'Medium', short: 'medium', detail: 'Medium · balanced' },
  high: { long: 'High', short: 'high', detail: 'High · default for real work' },
  max: { long: 'Max', short: 'max', detail: 'Max · usage limits apply' },
  xhigh: { long: 'Extra', short: 'extra', detail: 'Extra · longer turns' },
  ultra: { long: 'Ultra', short: 'ultra', detail: 'Ultra · may fan out to sub-agents outside o8. Longest turns, usage limits apply' },
};

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && THINKING_EFFORTS.includes(value as ThinkingEffort);
}

export function isManualThinkingEffort(value: unknown): value is ManualThinkingEffort {
  return typeof value === 'string' && MANUAL_THINKING_EFFORTS.includes(value as ManualThinkingEffort);
}

/**
 * Value for the Claude CLI `--effort` flag. Claude has no `ultra` tier (that's a
 * Codex flagship reasoning level), so a stale `ultra` selection carried
 * onto a Claude turn maps down to `max`. Every other tier passes through
 * byte-identically.
 */
export function claudeEffortFlagValue(effort: string): string {
  return effort === 'ultra' ? 'max' : effort;
}
