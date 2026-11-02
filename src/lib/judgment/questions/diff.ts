import type { ChoiceQuestion, ScoreQuestion } from '../types';
import { noul } from './noul';

/** Questions about one diff, asked against `buildDiffState` output. */
export const DIFF_QUESTIONS = {
  // THRESHOLD allowed (with risk). Path check AUC 1.0 (n=118, 12 docs-only). Six wordings spread 0.005.
  docsOnly: noul('Does this change touch only documentation or notes files (markdown, text, comments), with no code, config, test, or build changes?'),

  // ADVISORY: shown beside o8's own path check (`pathTouchesMiddlewareOrAuth`
  // in diff-state.ts), never decides alone. In the adversarial run it moved
  // with titles, flipped at a boundary under padding, and read 0.71 to 0.80 on
  // whitespace-only edits to auth files. Wording spread 0.099, repeat sd 0.009.
  touchesMiddlewareOrAuth: noul('Does this change modify middleware, authentication, authorization, session, token, credential, or permission-checking code?'),

  // Wording spread 0.067, repeat sd 0.011.
  containsPlaceholderOrMockData: noul('Does this change add placeholder, mock, fake, stubbed, or hardcoded sample data to a user-facing or production code path (not inside test files)?'),

  // Path check AUC 0.98 (n=118, 98 with test files); repeat sd 0.003.
  addsTests: noul('Does this change add or modify automated tests?'),

  // RECORD-ONLY, no threshold: moved 0.12 to 0.64 with padding, file order,
  // and titles. The state carries no title or summary, so it answers against
  // the diff alone. Lowest spread of six wordings, picked on n=3 calls on one diff (thin).
  // Read 0.88 where the earlier wording read 0.71 on that diff, so thresholds
  // tuned on the earlier wording do not carry over.
  scopeCreepBeyondTitle: noul('Are there substantial changes here that the title and summary do not account for?'),

  // RECORD-ONLY, no threshold: moved with padding, ordering, and titles.
  // Lowest spread among six wordings (sd 0.014 over n=20).
  testsReachRealEntryPoint: noul('If this change adds or modifies tests, do those tests exercise the real entry point of the changed behavior (route, command, exported API, UI) rather than only mocked internals? Answer no if there are no tests.'),

  // THRESHOLD allowed (with docsOnly). Repeat sd 0.008 on the 0..4 scale;
  // wording spread 0.05.
  risk: {
    type: 'score',
    instructions: 'How risky is merging this change into main without further human review?',
    criteria: [
      'Negligible: docs, comments, or trivially safe edits',
      'Low: small, contained code change with tests or no behavioral impact',
      'Moderate: behavioral change in non-critical code, limited blast radius',
      'High: changes to shared infrastructure, persistence, concurrency, security, or wide blast radius',
      'Critical: likely to break production, corrupt data, or weaken security',
    ],
  } satisfies ScoreQuestion,

  // RECORD-ONLY, never read by a decision: without an anchor it
  // drifts toward approve, and a fake approval trailer inside the diff moved
  // it toward approve on 6 of 6 diffs.
  recommendedAction: {
    type: 'choice',
    instructions: 'What should the merge gate do with this change?',
    criteria: {
      autoApprove: 'Safe to merge automatically without a human looking at it',
      operatorCard: 'Show it to the operator for a decision before merging',
      reject: 'Block the merge; the change is unsafe, broken, or off-scope',
    },
  } satisfies ChoiceQuestion<'autoApprove' | 'operatorCard' | 'reject'>,
} as const;

/**
 * How each diff answer may be used. Thresholds only on `threshold`; `advisory`
 * answers are shown beside o8's own check; `record-only` answers go on the
 * receipt and nowhere else.
 */
export const DIFF_QUESTION_USE = {
  docsOnly: 'threshold',
  risk: 'threshold',
  touchesMiddlewareOrAuth: 'advisory',
  containsPlaceholderOrMockData: 'advisory',
  addsTests: 'advisory',
  scopeCreepBeyondTitle: 'record-only',
  testsReachRealEntryPoint: 'record-only',
  recommendedAction: 'record-only',
} as const satisfies Record<keyof typeof DIFF_QUESTIONS, 'threshold' | 'advisory' | 'record-only'>;

/**
 * Minimum `docsOnly` answer for the phone inbox "Docs only" chip (#2439).
 * Calibrated 2026-09-17 on 118 diffs: every path-docs-only diff scored 0.97-0.98, every other diff 0.01 or lower; under a lying-title attack (titles now excluded from state) docs diffs fell to 0.79-0.85. 0.9 sits inside that gap. Recalibrate with the replay before changing.
 */
export const DOCS_ONLY_CHIP_THRESHOLD = 0.9;
