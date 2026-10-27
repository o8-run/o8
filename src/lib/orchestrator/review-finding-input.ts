import type { OrchestratorReviewFinding } from '@/lib/approvals/types';

const FINDING_STATUS_VALUES = ['fixed', 'accepted', 'deferred'] as const;
const FINDING_STATUS_HINT = `Valid values: ${FINDING_STATUS_VALUES.join(', ')}. Put free-text fix details in description or fixSuggestion.`;

function formatUnsupportedValue(value: unknown) {
  return typeof value === 'string' ? value : String(value);
}

function normalizeFindingSeverity(value: unknown): OrchestratorReviewFinding['severity'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'bug' || normalized === 'high' || normalized === 'critical' || normalized === 'error') {
    return 'bug';
  }
  if (
    normalized === 'rule_violation'
    || normalized === 'medium'
    || normalized === 'warning'
    || normalized === 'policy'
  ) {
    return 'rule_violation';
  }
  if (normalized === 'note' || normalized === 'low' || normalized === 'info') {
    return 'note';
  }
  throw new Error(`Unsupported finding severity: ${formatUnsupportedValue(value)}. Set severity to bug, rule_violation, or note.`);
}

function normalizeFindingStatus(
  value: unknown,
  fieldName: 'status' | 'resolution',
): OrchestratorReviewFinding['resolution'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'fixed' || normalized === 'resolved') {
    return 'fixed';
  }
  if (normalized === 'accepted' || normalized === 'waived' || normalized === 'intentional') {
    return 'accepted';
  }
  if (normalized === 'deferred' || normalized === 'todo' || normalized === 'followup' || normalized === 'follow-up') {
    return 'deferred';
  }
  throw new Error(`Unsupported finding ${fieldName}: ${formatUnsupportedValue(value)}. ${FINDING_STATUS_HINT}`);
}

export function parseReviewFindings(value: unknown): OrchestratorReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error('findings must be an array');
  }

  return value.map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      throw new Error(`findings[${index}] must be an object`);
    }

    const candidate = finding as Record<string, unknown>;
    const file = typeof candidate.file === 'string' ? candidate.file.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    if (!file || !description) {
      throw new Error(`findings[${index}] must include file and description`);
    }

    const line = candidate.line;
    if (line !== undefined && (typeof line !== 'number' || !Number.isFinite(line) || line < 1)) {
      throw new Error(`findings[${index}].line must be a positive number`);
    }

    const hasStatus = candidate.status !== undefined;
    const statusValue = hasStatus ? candidate.status : candidate.resolution;
    if (statusValue === undefined) {
      throw new Error(`findings[${index}] must include status. ${FINDING_STATUS_HINT}`);
    }

    const fixSuggestion = typeof candidate.fixSuggestion === 'string'
      ? candidate.fixSuggestion.trim()
      : '';

    return {
      file,
      line: typeof line === 'number' ? Math.floor(line) : undefined,
      severity: normalizeFindingSeverity(candidate.severity),
      description,
      resolution: normalizeFindingStatus(statusValue, hasStatus ? 'status' : 'resolution'),
      fixSuggestion: fixSuggestion || undefined,
    };
  });
}

/**
 * #732 — submit_review accepts an optional `directivesApplied: string[]`. The
 * orchestrator names each directive it verified the diff respected. Invalid
 * entries (non-strings, empty) are dropped silently — directive surfacing is
 * additive metadata; it should not fail an otherwise-valid review.
 */
export function parseDirectivesApplied(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) cleaned.push(trimmed);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface ParsedDirectiveViolation {
  directive: string;
  file?: string;
  line?: number | null;
  snippet?: string;
}

/**
 * #732 — submit_review accepts an optional `directivesViolated` array. Each
 * entry must at minimum name the directive; file/line/snippet are optional
 * but recommended. Same permissive-drop philosophy as parseDirectivesApplied.
 */
export function parseDirectivesViolated(value: unknown): ParsedDirectiveViolation[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const cleaned: ParsedDirectiveViolation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const directive = typeof entry.directive === 'string' ? entry.directive.trim() : '';
    if (!directive) continue;
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    const snippet = typeof entry.snippet === 'string' ? entry.snippet.trim() : '';
    const lineRaw = entry.line;
    const line = typeof lineRaw === 'number' && Number.isFinite(lineRaw) && lineRaw >= 1
      ? Math.floor(lineRaw)
      : undefined;
    cleaned.push({
      directive,
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}
