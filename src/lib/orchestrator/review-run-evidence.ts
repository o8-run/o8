/** Structured reviewer observations. These are reported receipts, not independently attested execution. */
export type ReviewRunEvidence = { status: 'not_run'; reason: string } | {
  status: 'run';
  headSha: string;
  reviewerRuntime: string;
  recordedAt: string;
  observations: Array<{
    kind: 'command' | 'launch';
    command: string;
    result: string;
    exitCode: number | null;
    excerpt?: string;
    artifact?: string;
  }>;
};
export type ReviewMode = 'read_only' | 'run';
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function readRunEvidence(value: unknown): ReviewRunEvidence | null {
  if (!object(value)) return null;
  if (value.status === 'not_run') return text(value.reason, 2_000) ? { status: 'not_run', reason: value.reason.trim() } : null;
  if (value.status !== 'run' || !text(value.headSha, 40) || !/^[a-f0-9]{40}$/i.test(value.headSha)
    || !text(value.reviewerRuntime, 100) || !text(value.recordedAt, 40)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.recordedAt) || !Number.isFinite(Date.parse(value.recordedAt))
    || !Array.isArray(value.observations) || value.observations.length < 1 || value.observations.length > 20) return null;
  const observations: Extract<ReviewRunEvidence, { status: 'run' }>['observations'] = [];
  for (const row of value.observations) {
    if (!object(row) || (row.kind !== 'command' && row.kind !== 'launch') || !text(row.command, 2_000)
      || !text(row.result, 2_000) || !(Number.isSafeInteger(row.exitCode) || row.kind === 'launch' && row.exitCode === null)
      || row.excerpt !== undefined && !text(row.excerpt, 4_000) || row.artifact !== undefined && !text(row.artifact, 1_000)
      || row.excerpt === undefined && row.artifact === undefined) return null;
    observations.push({ kind: row.kind, command: row.command.trim(), result: row.result.trim(), exitCode: row.exitCode as number | null,
      ...(row.excerpt !== undefined ? { excerpt: row.excerpt as string } : {}), ...(row.artifact !== undefined ? { artifact: row.artifact as string } : {}) });
  }
  return { status: 'run', headSha: value.headSha.toLowerCase(), reviewerRuntime: value.reviewerRuntime.trim(), recordedAt: value.recordedAt, observations };
}
export function reviewExecution(approved: boolean, head: unknown, value: unknown) {
  const parsed = readRunEvidence(value);
  const runEvidence: ReviewRunEvidence = parsed?.status === 'run' && (typeof head !== 'string' || parsed.headSha !== head.toLowerCase())
    ? { status: 'not_run', reason: 'Run evidence does not match the exact reviewed HEAD.' }
    : parsed ?? { status: 'not_run', reason: 'No valid structured run evidence was recorded.' };
  const reviewMode: ReviewMode = runEvidence.status === 'run' ? 'run' : 'read_only';
  return { runEvidence, reviewMode, verdictLabel: `${approved ? 'approved' : 'changes requested'}, ${reviewMode === 'run' ? 'run' : 'not run'}` };
}
export const REVIEW_RUN_EVIDENCE_PROMPT = 'For user-facing changes, exercise the reviewed commit through its real entry point and include structured runEvidence. Use {status:"run",headSha:"<full git rev-parse HEAD>",reviewerRuntime:"<reviewer runtime>",recordedAt:"<ISO timestamp>",observations:[{kind:"command"|"launch",command:"<command or launch and steps>",result:"<observed result>",exitCode:0,excerpt:"<bounded output>"}]} (artifact may replace excerpt; a launch may use exitCode:null). If not exercised, use {status:"not_run",reason:"<specific limitation>"}. Never infer execution from prose, a screenshot of another commit, or the author\'s claims. No evidence means a read-only review: approved, not run. Do not claim a run you did not observe.';
export const RUN_EVIDENCE_SCHEMA = {
  type: 'object', description: 'Structured execution receipts bound to the reviewed HEAD, or an explicit not_run reason. Validated on the server.',
  properties: {
    status: { type: 'string', enum: ['run', 'not_run'] }, reason: { type: 'string', maxLength: 2000 },
    headSha: { type: 'string', pattern: '^[a-fA-F0-9]{40}$' }, reviewerRuntime: { type: 'string', maxLength: 100 }, recordedAt: { type: 'string', maxLength: 40 },
    observations: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['command', 'launch'] }, command: { type: 'string', maxLength: 2000 }, result: { type: 'string', maxLength: 2000 },
      exitCode: { type: ['integer', 'null'] }, excerpt: { type: 'string', maxLength: 4000 }, artifact: { type: 'string', maxLength: 1000 },
    }, required: ['kind', 'command', 'result', 'exitCode'], additionalProperties: false } },
  }, required: ['status'], additionalProperties: false,
} as const;
