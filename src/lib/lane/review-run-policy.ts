import { reviewExecution } from '@/lib/orchestrator/review-run-evidence';
import { getApproval } from '@/lib/approvals/store';
import { assessDurableApprovedReview } from './durable-review-approval';
import { readHeadSha } from './head-sha-lock';
import { resolveLaneAttributionBase } from './attribution-base';
import { laneGit } from './lane-git';
import type { Lane } from './types';

export type RunEvidenceRefusalCode = 'review_run_evidence_required' | 'review_run_policy_invalid' | 'review_run_diff_unavailable';
export type RunEvidenceGate = { ok: true; message: string } | { ok: false; code: RunEvidenceRefusalCode; message: string };
/** Deliberately small glob grammar: *, ** and ?. Unsupported syntax fails closed. */
function patternRegex(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 's');
}
/** Off by default. Read the operator-owned server environment, never the reviewed repository. */
export async function checkReviewRunPolicy(lane: Lane): Promise<RunEvidenceGate> {
  const raw = process.env.O8_REVIEW_RUN_REQUIRED_PATHS;
  if (!raw?.trim()) return { ok: true, message: 'Run evidence policy is off.' };
  let patterns: RegExp[];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 100 || value.some(p => typeof p !== 'string' || !p || p.length > 500
      || p.startsWith('/') || p.split('/').some((s: string) => s === '..' || s === '.') || /[\\\[\]{}!\x00-\x20]/.test(p))) throw new Error('Invalid patterns');
    patterns = value.map(patternRegex);
  } catch {
    return { ok: false, code: 'review_run_policy_invalid', message: 'O8_REVIEW_RUN_REQUIRED_PATHS must be a JSON array of relative path globs using *, ** or ?.' };
  }
  if (!patterns.length) return { ok: true, message: 'Run evidence policy is off.' };
  try {
    const cwd = lane.worktreePath || lane.repoPath;
    const head = await readHeadSha(cwd, lane.repoPath);
    const resolution = await resolveLaneAttributionBase(lane, cwd, head);
    if (resolution.usedFallback || resolution.warning) throw new Error('Diff base is unverified');
    const base = resolution.mergeBase ?? resolution.comparisonRef;
    // Include both sides of renames and exact paths, including whitespace/newlines.
    const { stdout } = await laneGit(cwd, lane.repoPath, ['diff', '--name-only', '--no-renames', '-z', `${base}..${head}`, '--']);
    const matched = stdout.split('\0').filter(file => file && patterns.some(pattern => pattern.test(file)));
    if (!matched.length) return { ok: true, message: 'No changed paths require run evidence.' };
    const review = await assessDurableApprovedReview(lane);
    const approval = review.approvalId ? getApproval(review.approvalId) : null;
    const execution = reviewExecution(approval?.args?.approved === true, head, approval?.args?.runEvidence);
    if (!review.approved || approval?.args?.reviewedHeadSha !== head || execution.reviewMode !== 'run') {
      return { ok: false, code: 'review_run_evidence_required', message: `Run evidence is required for the exact reviewed HEAD ${head}; the approval is read-only or unavailable. Matching paths: ${matched.slice(0, 5).join(', ')}. Submit structured runEvidence after exercising this commit.` };
    }
    return { ok: true, message: `Current-head run evidence is recorded for ${matched.length} matching path(s).` };
  } catch {
    return { ok: false, code: 'review_run_diff_unavailable', message: 'The configured run-evidence policy could not verify the changed paths. Restore the packet repository and diff base before merging.' };
  }
}
