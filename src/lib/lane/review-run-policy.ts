import { reviewExecution } from '@/lib/orchestrator/review-run-evidence';
import { getApproval } from '@/lib/approvals/store';
import { assessDurableApprovedReview } from './durable-review-approval';
import { readHeadSha, resolveHeadSha } from './head-sha-lock';
import { resolveLaneAttributionBase } from './attribution-base';
import { laneGit } from './lane-git';
import type { Lane } from './types';

export type RunEvidenceRefusalCode = 'review_run_evidence_required' | 'review_run_policy_invalid' | 'review_run_diff_unavailable' | 'review_run_candidate_unavailable';
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
  return new RegExp(`${source}$`, 'is');
}
export function reviewRunPolicy() {
  const raw = process.env.O8_REVIEW_RUN_REQUIRED_PATHS;
  const source = raw?.trim() ? 'environment:O8_REVIEW_RUN_REQUIRED_PATHS' : 'default';
  if (!raw?.trim()) return { enabled: false, source, paths: [] as string[], valid: true };
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 100 || value.some(p => typeof p !== 'string' || !p || p.length > 500)) throw new Error('Invalid patterns');
    const paths = (value as string[]).map(p => p.replaceAll('\\', '/'));
    if (paths.some(p => p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some(s => s === '..' || s === '.') || /[\[\]{}!\x00-\x20]/.test(p))) throw new Error('Invalid patterns');
    return { enabled: paths.length > 0, source, paths, valid: true };
  } catch { return { enabled: true, source, paths: [] as string[], valid: false }; }
}
export function reviewRunPolicyConfiguration(): RunEvidenceGate {
  return reviewRunPolicy().valid ? { ok: true, message: 'Run evidence policy configuration is valid.' }
    : { ok: false, code: 'review_run_policy_invalid', message: 'O8_REVIEW_RUN_REQUIRED_PATHS must be a JSON array of relative path globs using *, ** or ?.' };
}
/** Early admission checks only configuration and cleanliness, never evidence for a mutable tip. */
export async function checkReviewRunPreflight(lane: Lane, cwd = lane.worktreePath): Promise<RunEvidenceGate> {
  if (!reviewRunPolicy().enabled) return { ok: true, message: 'Run evidence policy is off.' };
  const config = reviewRunPolicyConfiguration();
  if (!config.ok) return config;
  if (!cwd) return { ok: false, code: 'review_run_candidate_unavailable', message: 'Run-evidence policy requires a resolved remote merge candidate before merging.' };
  try {
    const { stdout: dirty } = await laneGit(cwd, lane.repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return dirty.length
      ? { ok: false, code: 'review_run_candidate_unavailable', message: 'Run-evidence policy requires a clean, committed merge candidate. Commit pending edits and review that exact commit before merging; merge-time commits are refused.' }
      : { ok: true, message: 'The source worktree is clean; evidence is checked against the resolved candidate.' };
  } catch {
    return { ok: false, code: 'review_run_candidate_unavailable', message: 'Run-evidence policy could not verify that the candidate worktree is clean.' };
  }
}
/** Evaluate the resolved source commit before rebase. No merge-time snapshot is allowed under this policy. */
export async function checkReviewRunPolicy(lane: Lane, candidate?: { cwd: string; sha: string }): Promise<RunEvidenceGate> {
  const policy = reviewRunPolicy();
  if (!policy.enabled) return { ok: true, message: 'Run evidence policy is off.' };
  const cwd = candidate?.cwd ?? lane.worktreePath ?? '';
  const preflight = await checkReviewRunPreflight(lane, cwd);
  if (!preflight.ok) return preflight;
  const patterns = policy.paths.map(patternRegex);
  try {
    const head = await resolveHeadSha(cwd, candidate?.sha ?? await readHeadSha(cwd, lane.repoPath), lane.repoPath);
    if (!head) return { ok: false, code: 'review_run_candidate_unavailable', message: 'The final source merge-candidate SHA could not be established.' };
    const resolution = await resolveLaneAttributionBase(lane, cwd, head);
    if (resolution.usedFallback || resolution.warning) throw new Error('Diff base is unverified');
    const base = resolution.mergeBase ?? resolution.comparisonRef;
    // Include both sides of renames and exact paths, including whitespace/newlines.
    const { stdout } = await laneGit(cwd, lane.repoPath, ['diff', '--name-only', '--no-renames', '-z', `${base}..${head}`, '--']);
    const matched = stdout.split('\0').filter(file => file && patterns.some(pattern => pattern.test(file.replaceAll('\\', '/'))));
    if (!matched.length) return { ok: true, message: 'No changed paths require run evidence.' };
    const review = await assessDurableApprovedReview({ ...lane, worktreePath: cwd }, head);
    const approval = review.approvalId ? getApproval(review.approvalId) : null;
    const execution = reviewExecution(approval?.args?.approved === true, head, approval?.args?.runEvidence);
    const principal = execution.runEvidence.status === 'run' ? execution.runEvidence.principal : null;
    const assignedToPacket = principal?.role === 'operator' || principal?.role === 'assigned_reviewer' && principal.packetId === lane.packetId;
    if (!assignedToPacket || !review.approved || approval?.args?.reviewedHeadSha !== head || execution.reviewMode !== 'run') {
      return { ok: false, code: 'review_run_evidence_required', message: `Run evidence is required for the exact reviewed HEAD ${head}; ${approval ? 'the approval is read-only or does not authorize this commit' : 'no approved review authorizes this commit'}. Matching paths: ${matched.slice(0, 5).join(', ')}. Submit structured runEvidence after exercising this commit.` };
    }
    return { ok: true, message: `Current-head run evidence is recorded for ${matched.length} matching path(s).` };
  } catch {
    return { ok: false, code: 'review_run_diff_unavailable', message: 'The configured run-evidence policy could not verify the changed paths. Restore the packet repository and diff base before merging.' };
  }
}
