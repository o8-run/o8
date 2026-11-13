import { reviewExecution } from '@/lib/orchestrator/review-run-evidence';
import 'server-only';

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getActiveReviewerBackend } from '@/lib/lane/orchestrator-backends/registry';
import { classifyReviewRisk } from '@/lib/lane/review-risk';
import { extractAddedDiffLines } from '@/lib/lane/lane-diff-facts';
import { EVALUATOR_DIFF_BYTE_LIMIT } from './capabilities';
import type {
  HarnessEvaluationFinding,
  HarnessEvaluationResult,
  HarnessEvaluationVerdict,
} from './types';

const BLIND_REVIEW_TOOL_EVENT_BACKENDS = new Set([
  'acp',
  'claude',
  'codex',
  'fable',
  'hermes',
  'o8',
]);

function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match && match[1] !== '/dev/null') files.add(match[1]);
  }
  return [...files];
}

function cleanFinding(value: unknown): HarnessEvaluationFinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const severity = row.severity;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const detail = typeof row.detail === 'string' ? row.detail.trim() : '';
  if (!['critical', 'high', 'medium', 'low'].includes(String(severity)) || !title || !detail) return null;
  return {
    severity: severity as HarnessEvaluationFinding['severity'],
    file: typeof row.file === 'string' && row.file.trim() ? row.file.trim().slice(0, 1_000) : null,
    line: Number.isInteger(row.line) && Number(row.line) > 0 ? Number(row.line) : null,
    title: title.slice(0, 300),
    detail: detail.slice(0, 4_000),
  };
}

function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseEvaluationResponse(input: {
  raw: string;
  risk: 'standard' | 'high';
  riskReasons: string[];
  reviewerBackend: string | null;
}): HarnessEvaluationResult {
  const parsed = extractJson(input.raw);
  const verdict = parsed?.verdict;
  const validVerdict = verdict === 'approve' || verdict === 'request_changes' || verdict === 'inconclusive'
    ? verdict as HarnessEvaluationVerdict
    : 'inconclusive';
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map(cleanFinding).filter((finding): finding is HarnessEvaluationFinding => finding !== null).slice(0, 50)
    : [];
  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, 5_000)
    : parsed
      ? 'The reviewer returned no summary.'
      : 'The reviewer response was not valid structured JSON.';
  return {
    schema: 'o8/evaluate-diff/v1',
    ...reviewExecution(validVerdict === 'approve', null, { status: 'not_run', reason: 'Self-contained diff evaluation does not launch or exercise a commit.' }),
    verdict: validVerdict,
    verdictLabel: `${validVerdict === 'approve' ? 'approved' : validVerdict === 'request_changes' ? 'changes requested' : 'inconclusive'}, not run`,
    summary,
    findings,
    risk: input.risk,
    riskReasons: input.riskReasons,
    reviewerBackend: input.reviewerBackend,
    reviewedAt: Date.now(),
  };
}

function buildPrompt(input: {
  task: string;
  diff: string;
  acceptanceCriteria: string[];
  risk: 'standard' | 'high';
  riskReasons: string[];
}): string {
  return [
    'You are o8_evaluate_diff, an independent skeptical evaluator.',
    'This review is deliberately self-contained. The task, acceptance criteria, and complete patch below are the only evidence you need, and the repository is intentionally empty.',
    'Do not call or request any tool, inspect the repository, browse, modify files, or try to verify line numbers externally. Any tool-use event aborts the review and records no verdict.',
    'Reason directly from the supplied patch. Do not ask for more context. Report only concrete findings caused by the patch, and cite the patch path and new-file line when possible.',
    'You did not see the generator transcript, plan, self-review, or claimed test results. Approve the patch when the supplied evidence shows no correctness defect; use inconclusive only when the supplied patch itself cannot support a verdict.',
    input.risk === 'high'
      ? `This is a high-risk patch. Try to disprove its scope partition and state-transition safety. Risk signals: ${input.riskReasons.join('; ')}`
      : 'Check correctness, security, persistence, error handling, and whether the patch can be reached from its real entry point.',
    '',
    'This evaluator cannot run a commit. Return runEvidence:{status:"not_run",reason:"Self-contained diff evaluation cannot exercise a commit."}. Never claim execution from the patch or prose. Approval is approved, not run.',
    'Return one JSON object and no prose:',
    '{"verdict":"approve|request_changes|inconclusive","summary":"...","findings":[{"severity":"critical|high|medium|low","file":"path or null","line":123,"title":"...","detail":"..."}]}',
    '',
    'Task:',
    input.task,
    '',
    'Acceptance criteria:',
    ...(input.acceptanceCriteria.length ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`) : ['- No explicit criteria supplied.']),
    '',
    'Unified diff:',
    input.diff,
    '',
    'Return the JSON verdict now without calling tools.',
  ].join('\n');
}

export async function evaluateDiff(input: {
  repoPath: string;
  task: string;
  diff: string;
  acceptanceCriteria?: string[];
  signal?: AbortSignal;
  disallowTools?: boolean;
}): Promise<HarnessEvaluationResult> {
  const task = input.task.trim();
  if (!task) throw new Error('task is required');
  if (task.length > 50_000) throw new Error('task exceeds 50000 characters');
  if (!input.diff.trim()) throw new Error('diff is required');
  const diffBytes = Buffer.byteLength(input.diff, 'utf8');
  if (diffBytes > EVALUATOR_DIFF_BYTE_LIMIT) {
    throw new Error(`diff exceeds ${EVALUATOR_DIFF_BYTE_LIMIT} bytes`);
  }
  const criteria = (input.acceptanceCriteria ?? [])
    .map((criterion) => criterion.trim())
    .filter(Boolean)
    .slice(0, 100);
  const risk = classifyReviewRisk(changedFiles(input.diff), extractAddedDiffLines(input.diff));
  const backend = getActiveReviewerBackend();
  if (input.disallowTools && !BLIND_REVIEW_TOOL_EVENT_BACKENDS.has(backend.id)) {
    return parseEvaluationResponse({
      raw: JSON.stringify({
        verdict: 'inconclusive',
        summary: `Blind review cannot verify tool abstention for the configured ${backend.label} reviewer backend.`,
        findings: [],
      }),
      risk: risk.tier,
      riskReasons: risk.reasons,
      reviewerBackend: backend.id,
    });
  }
  const threadId = `thoughts-harness-evaluate-${randomUUID()}`;
  const session = backend.ensureSession(input.repoPath, undefined, threadId);
  if (session.status === 'busy' || session.status === 'dead') {
    return parseEvaluationResponse({
      raw: JSON.stringify({
        verdict: 'inconclusive',
        summary: `${backend.label} reviewer session is ${session.status}.`,
        findings: [],
      }),
      risk: risk.tier,
      riskReasons: risk.reasons,
      reviewerBackend: backend.id,
    });
  }

  let text = '';
  const errors: string[] = [];
  const toolProtocolController = input.disallowTools ? new AbortController() : null;
  const signal = toolProtocolController
    ? input.signal
      ? AbortSignal.any([input.signal, toolProtocolController.signal])
      : toolProtocolController.signal
    : input.signal;
  let toolProtocolBreached = false;
  try {
    await backend.sendTurn(
      input.repoPath,
      buildPrompt({
        task,
        diff: input.diff,
        acceptanceCriteria: criteria,
        risk: risk.tier,
        riskReasons: risk.reasons,
      }),
      (event) => {
        if (event.type === 'text') text += event.text;
        if (event.type === 'error') errors.push(event.error);
        if (
          input.disallowTools
          && !toolProtocolBreached
          && (event.type === 'tool_use' || event.type === 'tool_result')
        ) {
          toolProtocolBreached = true;
          const message = `Blind review protocol breach: reviewer emitted ${event.type} for ${event.name}.`;
          errors.push(message);
          toolProtocolController?.abort(new Error(message));
        }
      },
      {
        threadId,
        signal,
        permissionMode: 'plan',
        toolProfile: 'propose',
      },
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (input.signal?.aborted) {
    const reason = input.signal.reason instanceof Error
      ? input.signal.reason.message
      : String(input.signal.reason ?? 'aborted');
    errors.push(`Reviewer aborted: ${reason}`);
  }
  if (errors.length > 0) {
    text = JSON.stringify({
      verdict: 'inconclusive',
      summary: `Reviewer failed: ${errors.join('; ').slice(0, 1_000)}`,
      findings: [],
    });
  }
  return parseEvaluationResponse({
    raw: text,
    risk: risk.tier,
    riskReasons: risk.reasons,
    reviewerBackend: backend.id,
  });
}
