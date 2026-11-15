import { getSqlite } from '@/lib/db';
import type { ReviewRiskClassification } from './review-risk';

const objectId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Read the latest review's original classification, never recompute with a
 * different diff depth. Legacy unpinned events remain uncertain. No Git, fetch,
 * attribution resolver or shared fetch memo is used by this reader. */
export function readRecordedPolicyRisk(laneId: string, headSha: string): {
  risk: ReviewRiskClassification | null; comparisonRef: string | null; uncertain: boolean;
} {
  const row = getSqlite().prepare("SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'review_risk_classified' ORDER BY timestamp DESC, rowid DESC LIMIT 1")
    .get(laneId) as { payload_json: string } | undefined;
  const unknown = { risk: null, comparisonRef: null, uncertain: true };
  if (!row) return unknown;
  const value = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (value.reviewedHeadSha !== headSha || (value.tier !== 'standard' && value.tier !== 'high')
    || !strings(value.reasons) || !strings(value.responsibleFiles)) return unknown;
  const risk: ReviewRiskClassification = { tier: value.tier, reasons: value.reasons, responsibleFiles: value.responsibleFiles };
  const base = value.diffBase as Record<string, unknown> | null;
  const comparison = base?.mergeBase ?? base?.comparisonRef;
  return { risk, comparisonRef: objectId(comparison) ? comparison : null,
    uncertain: !objectId(comparison) || base?.usedFallback !== false || Boolean(base?.warning) };
}
