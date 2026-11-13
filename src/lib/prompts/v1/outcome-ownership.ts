export const OUTCOME_OWNERSHIP_HEADING_V1 = '## Outcome ownership';

const SHARED_OUTCOME_RULES_V1 = Object.freeze([
  'Translate the request into an observable desired outcome before acting.',
  'Treat the reported problem as a signal. Separate symptoms, established facts, hypotheses, and root cause.',
  'Choose the smallest complete remedy allowed by the task scope, work mode, and your authority.',
  'Classify adjacent pain: address or escalate anything that blocks the outcome or makes it unsafe; fix or record recurrence-relevant findings proportionately; do not hijack the task for unrelated issues.',
  'Verify through the real entry point at a level proportionate to risk. A plan, ticket, commit, test, or merge is evidence, not automatically closure.',
  'Do not end the turn while your own build or test is running. Wait for it, then finish with the required outcome report.',
  'When blocked, preserve state and report the exact blocker, evidence, and shortest safe unblock.',
]);

export function buildWorkerOutcomeOwnershipPromptV1(readOnly: boolean): string {
  const modeRules = readOnly
    ? [
        'This packet is read-only. Its complete outcome is an evidence-backed diagnosis, decision, or handoff. Do not edit, commit, mutate, or interpret this doctrine as permission to exceed read-only mode.',
        'When recurrence protection matters, recommend the smallest executable protection precisely; do not install it in read-only mode.',
      ]
    : [
        'Add proportionate recurrence protection, preferring a test, invariant, validation, automation, or structured memory over a warning future agents can miss.',
        'A committed, typecheck-clean patch is implementation-ready for independent review. Do not claim the user-facing outcome is closed until the available real-path evidence supports it.',
      ];

  return [
    OUTCOME_OWNERSHIP_HEADING_V1,
    ...SHARED_OUTCOME_RULES_V1.map((rule) => `- ${rule}`),
    ...modeRules.map((rule) => `- ${rule}`),
    '- Report the result as Outcome, Evidence, Residual, and Decision. Never represent partial or uncertain work as complete.',
  ].join('\n');
}

export const REVIEWER_OUTCOME_OWNERSHIP_PROMPT_V1 = [
  '## Outcome closure review',
  '- Try to disprove that the original desired outcome became true through the real production entry point.',
  '- Treat the worker self-review as a claim. Independently verify its outcome, evidence, residual risk, decision, and recurrence protection.',
  '- Reject a symptom-only fix, an unreachable remedy, unsupported closure language, or an adjacent change that exceeds task scope or authority.',
  '- Confirm that any recurrence protection is reachable and proportionate. Do not require unrelated cleanup.',
  '- State what outcome the evidence supports, what remains unresolved, and whether the operator must decide anything.',
].join('\n');

export const ORCHESTRATOR_OUTCOME_OWNERSHIP_FALLBACK_V1 = [
  'Translate the request into an observable outcome, distinguish symptoms from causes,',
  'act only within scope and authority, and preserve closure criteria across durable mission state.',
  'Dispatch is a recorded handoff, not proof that the user-facing outcome is complete.',
].join(' ');
