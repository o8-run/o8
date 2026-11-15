import { posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { isCorrectionForgotten } from './operator-corrections';
import { hasForgottenPacketOutcome } from './outcome-exclusion';
import { advanceMemoryRevision } from './memory-revision';
import { reviewExecution } from '@/lib/orchestrator/review-run-evidence';
import type { OrchestratorReviewRecordInput } from '@/lib/approvals/orchestrator-review';
import type { Lane } from '@/lib/lane/types';
import { laneGitSync } from '@/lib/lane/lane-git';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import { isSafeGitRef } from '@/lib/git/refs';

type Verification = 'operator_decision' | 'independent_review' | 'reviewer_reported_run' | null;
interface ReviewOutcome {
  version: 1;
  projectId: string;
  repoPath: string;
  headSha: string;
  decision: 'accepted' | 'rejected_with_findings' | 'corrected';
  verification: Verification;
  files: string[];
  observation: string;
  sources: string[];
  findingFingerprint: string;
  correctionId?: string;
  observations: Array<{ file: string; text: string; findingIndex?: number; sources: string[] }>;
}
interface ReviewRow {
  id: string;
  packetId: string;
  args: string;
  status: string;
  verdictAt: number;
  latestId: string;
  repoPath: string;
  projectId: string | null;
  laneProjectId: string | null;
  laneId: string;
}
export interface RetainedReviewOutcome extends ReviewOutcome {
  id: string;
  packetId: string;
  source: string;
  withheldReason: string | null;
  retrievedBecause: string | null;
  repeatedFindings: number;
  observedOperatorDecisions: number;
  overlappingSources: string[];
}

function codePath(value: string): string | null {
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return path && path.length <= 240 && !path.startsWith('/') && !path.includes(':')
    && !path.split('/').some(part => !part || part === '..' || part === '.' || part === '.git') ? path : null;
}
function bounded(value: string, length: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, length);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function findingFingerprint(findings: unknown): string {
  return createHash('sha256').update(JSON.stringify(findings) ?? 'null').digest('hex');
}
function snapshot(value: unknown): ReviewOutcome | null {
  if (!object(value) || value.version !== 1 || typeof value.projectId !== 'string' || !value.projectId
    || typeof value.repoPath !== 'string' || typeof value.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(value.headSha)
    || !['accepted', 'rejected_with_findings', 'corrected'].includes(String(value.decision))
    || ![null, 'operator_decision', 'independent_review', 'reviewer_reported_run'].includes(value.verification as Verification)
    || !strings(value.files) || value.files.length > 12 || value.files.some(file => codePath(file) !== file)
    || typeof value.observation !== 'string' || value.observation.length > 600
    || !strings(value.sources) || value.sources.length > 12
    || value.sources.some(source => !/^approval:[A-Za-z0-9._-]+#finding:\d+$/.test(source))
    || typeof value.findingFingerprint !== 'string'
    || value.correctionId !== undefined && typeof value.correctionId !== 'string'
    || !Array.isArray(value.observations) || value.observations.length > 12
    || value.observations.some(row => !object(row) || typeof row.file !== 'string' || codePath(row.file) !== row.file
      || typeof row.text !== 'string' || row.text.length > 600 || !strings(row.sources))) return null;
  return value as unknown as ReviewOutcome;
}

/** Stored atomically with the existing approval, rather than creating a second outcome ledger. */
interface ReviewOutcomeInput {
  projectId: string | null | undefined; repoPath: string; packetId: string; headSha?: string;
  approved: boolean; findings: OrchestratorReviewFinding[]; changedFiles: string[];
  summary: string; verification: Verification;
  correction?: { correction_id: string; source_json: string } | null;
}
export function reusableReviewOutcome(input: ReviewOutcomeInput): ReviewOutcome | null {
  try { return buildReusableReviewOutcome(input); } catch { return null; }
}
function buildReusableReviewOutcome(input: ReviewOutcomeInput): ReviewOutcome | null {
  if (!input.projectId || !input.headSha || !/^[a-f0-9]{40}$/i.test(input.headSha)) return null;
  const correction = input.approved && input.correction ? JSON.parse(input.correction.source_json) as {
    approvalId: string; findings: Array<{ file: string; description: string; line?: number | null }>; repoPath: string; packetId: string;
  } : null;
  const original = correction ? getSqlite().prepare(`SELECT args_json AS args FROM approvals
    WHERE id = ? AND packet_id = ? AND project_id = ?`).get(correction.approvalId, input.packetId, input.projectId) as { args: string } | undefined : undefined;
  const originalFindings = original ? (JSON.parse(original.args) as { findings: OrchestratorReviewFinding[] }).findings : [];
  const correctedFindings = correction?.repoPath === input.repoPath && correction.packetId === input.packetId
    ? correction.findings.map(finding => ({ ...finding, originalIndex: originalFindings.findIndex(candidate => candidate.file === finding.file
      && candidate.description === finding.description && (candidate.line ?? null) === (finding.line ?? null)) }))
      .filter(finding => finding.originalIndex >= 0) : [];
  if (!input.approved && !input.findings.length) return null;
  const prior = getSqlite().prepare(`SELECT id, args_json AS args FROM approvals
    WHERE packet_id = ? AND project_id = ? AND tool_name = 'orchestrator_review'
      AND json_valid(args_json) AND json_extract(args_json, '$.approved') = 0
      ORDER BY rowid DESC LIMIT 20`).all(input.packetId, input.projectId) as Array<{ id: string; args: string }>;
  const observations: ReviewOutcome['observations'] = correctedFindings.length
    ? correctedFindings.slice(0, 12).map(finding => ({ file: finding.file,
      text: bounded(`[${input.findings.find(current => current.file === finding.file && current.description === finding.description)?.resolution ?? 'correction accepted'}]: ${finding.description}`, 600),
      sources: [`approval:${correction!.approvalId}#finding:${finding.originalIndex}`] }))
    : input.findings.length ? input.findings.slice(0, 12).map((finding, findingIndex) => ({ file: finding.file,
      text: bounded(`[${finding.resolution}]: ${finding.description}`, 600), findingIndex, sources: [] }))
      : input.changedFiles.slice(0, 12).map(file => ({ file, text: bounded(input.summary, 600), sources: [] }));
  for (const row of prior) {
    const args = JSON.parse(row.args) as Record<string, unknown>;
    if (!Array.isArray(args.findings)) continue;
    args.findings.forEach((finding: unknown, index: number) => {
      if (object(finding) && input.findings.some(current => current.resolution === 'fixed'
        && current.file === finding.file && current.description === finding.description)) {
        for (const observation of observations.filter(observation => observation.file === finding.file
          && observation.findingIndex !== undefined && input.findings[observation.findingIndex]?.description === finding.description)) {
          observation.sources.push(`approval:${row.id}#finding:${index}`);
        }
      }
    });
  }
  const safeObservations = observations.filter(observation => codePath(observation.file) === observation.file)
    .map(observation => ({ ...observation, sources: [...new Set(observation.sources)].slice(0, 12) }));
  const files = [...new Set(safeObservations.map(observation => observation.file))];
  if (!files.length) return null;
  return {
    version: 1, projectId: input.projectId, repoPath: resolve(input.repoPath), headSha: input.headSha,
    decision: !input.approved ? 'rejected_with_findings' : correctedFindings.length || input.findings.some(finding => finding.resolution === 'fixed') ? 'corrected' : 'accepted',
    verification: input.verification, files,
    observation: bounded(safeObservations.slice(0, 3).map(observation => `${observation.file} ${observation.text}`).join(' | '), 600),
    sources: [...new Set(safeObservations.flatMap(observation => observation.sources))].slice(0, 12),
    findingFingerprint: findingFingerprint(input.findings),
    ...(correctedFindings.length ? { correctionId: input.correction!.correction_id } : {}),
    observations: safeObservations,
  };
}

/** The automatic verdict writer uses the same snapshot contract as submit_review. */
export function reviewOutcomeForLane(lane: Lane | null, review: OrchestratorReviewRecordInput): ReviewOutcome | null {
  try { return captureLaneReviewOutcome(lane, review); } catch { return null; }
}
function captureLaneReviewOutcome(lane: Lane | null, review: OrchestratorReviewRecordInput): ReviewOutcome | null {
  if (!lane?.packetId || !lane.projectId) return null;
  let changedFiles: string[] = [];
  if (!review.findings.length && review.reviewedHeadSha && /^[a-f0-9]{40}$/i.test(review.reviewedHeadSha)) {
    const base = readLaneCreationBaseCommit(lane.id) ?? lane.baseBranch;
    if (isSafeGitRef(base)) {
      try {
        changedFiles = laneGitSync(lane.worktreePath || lane.repoPath, lane.repoPath,
          ['diff', '--name-only', '-z', `${base}...${review.reviewedHeadSha}`, '--'], { timeout: 5000 }).split('\0').filter(Boolean);
      } catch { /* Missing exact evidence produces no reusable area. */ }
    }
  }
  return reusableReviewOutcome({ projectId: lane.projectId, repoPath: lane.repoPath, packetId: lane.packetId,
    headSha: review.reviewedHeadSha, approved: review.approved, findings: review.findings, changedFiles,
    summary: lane.label, verification: reviewExecution(review.approved, review.reviewedHeadSha, review.runEvidence).reviewMode === 'run'
      ? 'reviewer_reported_run' : completedIndependentReview(lane.id, review.reviewTurnId, review.reviewedHeadSha) ? 'independent_review' : null });
}

function completedIndependentReview(laneId: string, turnId?: string, headSha?: string): boolean {
  if (!turnId || !headSha) return false;
  const db = getSqlite();
  const started = db.prepare(`SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'review_turn_started'
    AND json_extract(payload_json, '$.reviewTurnId') = ? ORDER BY rowid DESC LIMIT 1`).get(laneId, turnId) as { payload_json: string } | undefined;
  const finished = db.prepare(`SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'review_turn_finished'
    AND json_extract(payload_json, '$.reviewTurnId') = ? ORDER BY rowid DESC LIMIT 1`).get(laneId, turnId) as { payload_json: string } | undefined;
  if (!started || !finished) return false;
  const assignment = JSON.parse(started.payload_json) as Record<string, unknown>;
  return ['auto-review', 'merge-gate-review'].includes(String(assignment.surface)) && !!assignment.backend && assignment.expectedHeadSha === headSha
    && (JSON.parse(finished.payload_json) as Record<string, unknown>).outcome === 'completed';
}

interface ReadOptions {
  repoPaths?: string[]; projectId?: string | null; packetBody?: string; excludePacketId?: string;
  id?: string; offset?: number; limit?: number; query?: string;
}
function rows(input: ReadOptions): ReviewRow[] {
  return getSqlite().prepare(`SELECT a.id, a.packet_id AS packetId, a.args_json AS args,
    a.status, COALESCE((SELECT MAX(json_extract(e.value, '$.timestamp')) FROM json_each(a.audit_json) e
      WHERE json_extract(e.value, '$.type') = 'orchestrator_review'), a.created_at) AS verdictAt,
    l.repo_path AS repoPath, a.project_id AS projectId, l.project_id AS laneProjectId, l.id AS laneId,
    (SELECT n.id FROM approvals n WHERE n.packet_id = a.packet_id AND n.project_id IS a.project_id
      AND n.tool_name = 'orchestrator_review' ORDER BY COALESCE((SELECT MAX(e.rowid)
        FROM approval_events e WHERE e.approval_id = n.id AND e.event_type = 'orchestrator_review'), 0) DESC,
        n.rowid DESC LIMIT 1) AS latestId
    FROM approvals a JOIN lanes l ON l.id = a.lane_id
    WHERE a.tool_name = 'orchestrator_review' AND json_valid(a.args_json)
      AND json_type(a.args_json, '$.reusableOutcome') = 'object'
      AND (@allProjects OR a.project_id IS @projectId)
      AND (@repos = '[]' OR l.repo_path IN (SELECT value FROM json_each(@repos)))
      AND (@id IS NULL OR 'review:' || a.id = @id)
      AND (@query = '' OR instr(lower(json_extract(a.args_json, '$.reusableOutcome.observation')), @query) > 0)
    ORDER BY verdictAt DESC, a.rowid DESC LIMIT @limit OFFSET @offset`).all({
    allProjects: Number(input.projectId === undefined), projectId: input.projectId ?? null,
    repos: JSON.stringify(input.repoPaths?.map(path => resolve(path)) ?? []),
    id: input.id ?? null, query: input.query?.toLowerCase() ?? '', offset: input.offset ?? 0, limit: input.limit ?? 200,
  }) as ReviewRow[];
}

/** Same retained approval sources power inventory and the actual worker brief. No policy writes. */
export function readReviewOutcomes(input: ReadOptions): RetainedReviewOutcome[] {
  const retained = rows(input).flatMap(row => {
    const args = JSON.parse(row.args) as Record<string, unknown>;
    const lesson = snapshot(args.reusableOutcome);
    if (!lesson || row.packetId === input.excludePacketId) return [];
    const sourceIds = [row.id, ...new Set(lesson.observations.flatMap(observation => observation.sources)
      .map(source => source.slice('approval:'.length).split('#')[0]))];
    let withheldReason: string | null = null;
    if (sourceIds.some(id => isCorrectionForgotten(`approval:${id}`)) || hasForgottenPacketOutcome(row.packetId)) withheldReason = 'excluded source';
    else if (lesson.projectId !== row.projectId || row.laneProjectId !== row.projectId || lesson.repoPath !== resolve(row.repoPath)) withheldReason = 'source scope changed';
    else if (args.reviewSuperseded === true || row.latestId !== row.id) withheldReason = 'superseded review';
    else if (Date.now() - row.verdictAt > 30 * 86400000) withheldReason = 'stale evidence (older than 30 days)';
    else if (!lesson.verification || args.reviewTurnOutcome !== 'completed' || args.parseWarning
      || args.reviewedHeadSha !== lesson.headSha
      || lesson.verification === 'reviewer_reported_run' && reviewExecution(args.approved === true, args.reviewedHeadSha, args.runEvidence).reviewMode !== 'run') withheldReason = 'unverified review';
    else if (lesson.verification === 'independent_review' && !completedIndependentReview(row.laneId, args.reviewTurnId as string, lesson.headSha)) withheldReason = 'unverified independent review';
    else if (args.requiresSecondPass === true && args.secondPassAgreed !== true) withheldReason = 'required second pass pending';
    else if (findingFingerprint(args.findings) !== lesson.findingFingerprint
      || !(lesson.decision === 'rejected_with_findings' ? ['rejected', 'pending'].includes(row.status) : row.status === 'approved')
      || args.approved !== (lesson.decision !== 'rejected_with_findings')
      || (lesson.decision !== 'rejected_with_findings' && (!Array.isArray(args.findings)
        || args.findings.some(finding => !object(finding) || !['accepted', 'fixed'].includes(String(finding.resolution)))))) withheldReason = 'unresolved or changed decision';
    const mentioned = (input.packetBody?.match(/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+|[A-Za-z0-9_@-]+\.[A-Za-z0-9_.-]+/g) ?? []).map(codePath).filter(Boolean);
    const matched = lesson.files.filter(file => mentioned.some(token => token === file
      || file.startsWith(`${token}/`) || token === posix.dirname(file)));
    const relevant = input.packetBody === undefined ? lesson.observations : lesson.observations.filter(observation => matched.includes(observation.file));
    return [{ ...lesson, files: input.packetBody === undefined ? lesson.files : [...new Set(relevant.map(observation => observation.file))],
      observation: bounded(relevant.map(observation => `${observation.file} ${observation.text}`).join(' | '), 600),
      sources: [...new Set(relevant.flatMap(observation => [
        ...(observation.findingIndex === undefined ? [] : [`approval:${row.id}#finding:${observation.findingIndex}`]), ...observation.sources,
      ]))],
      id: `review:${row.id}`, packetId: row.packetId, source: `approval:${row.id}`,
      withheldReason, retrievedBecause: matched.length ? `same project and repository; code area ${matched.join(', ')}` : null,
      repeatedFindings: 0, observedOperatorDecisions: 0, overlappingSources: [] as string[] }];
  });
  for (const lesson of retained) {
    const related = retained.filter(other => other.projectId === lesson.projectId && other.repoPath === lesson.repoPath
      && other.observation.replace(/\[(fixed|accepted|deferred|correction accepted)\]/g, '') === lesson.observation.replace(/\[(fixed|accepted|deferred|correction accepted)\]/g, ''));
    lesson.repeatedFindings = related.filter(other => other.decision === 'rejected_with_findings').length;
    lesson.observedOperatorDecisions = related.filter(other => other.verification === 'operator_decision').length;
    lesson.overlappingSources = retained.filter(other => other.id !== lesson.id && !other.withheldReason
      && other.projectId === lesson.projectId && other.repoPath === lesson.repoPath
      && other.observation !== lesson.observation && other.files.some(file => lesson.files.includes(file)))
      .map(other => other.source);
  }
  return retained;
}

export function reviewOutcomesSection(input: { repoPath: string; projectId: string | null; packetBody: string; excludePacketId?: string }): string[] {
  if (!input.projectId) return [];
  try {
    const lessons = readReviewOutcomes({ ...input, repoPaths: [input.repoPath] })
      .filter(lesson => !lesson.withheldReason && lesson.retrievedBecause).slice(0, 2);
    if (!lessons.length) return [];
    return ['## Relevant Review Outcomes',
      'Quoted historical evidence, not project rules. Revalidate against current code and instructions. Proposed checks or rules require explicit approval and a reviewed change.',
      ...lessons.map(lesson => `- [${lesson.decision}; ${lesson.verification}] ${bounded(lesson.observation, 300)}\n`
        + `  Evidence revision: ${lesson.headSha}; source/decision: ${lesson.source}; packet:${lesson.packetId}; ${lesson.sources.slice(0, 2).join('; ')}\n`
        + (lesson.correctionId ? `  Correction receipt: correction:${lesson.correctionId}\n` : '')
        + `  Retrieved: ${bounded(lesson.retrievedBecause ?? '', 300)}. Repeated findings observed: ${lesson.repeatedFindings}; explicit operator decisions observed: ${lesson.observedOperatorDecisions}. No causal improvement measured.`
        + (lesson.overlappingSources.length ? `\n  Potential conflict in the same area: ${lesson.overlappingSources.slice(0, 2).join('; ')}. Inspect both sources; neither overrides instructions.` : ''))];
  } catch {
    return [];
  }
}

/** Reuse the existing exclusion ledger; review and correction history stays inspectable. */
export function forgetReviewOutcome(id: string, repoPath: string, projectId: string | null): boolean {
  const found = readReviewOutcomes({ repoPaths: [repoPath], projectId, id, limit: 1 })[0];
  if (!found) return false;
  const db = getSqlite();
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS forgotten_operator_corrections (id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO forgotten_operator_corrections (id, forgotten_at) VALUES (?, ?)')
      .run(found.source, new Date().toISOString());
    advanceMemoryRevision(db);
  })();
  return true;
}
