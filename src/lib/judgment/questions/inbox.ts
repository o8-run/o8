import type { ScoreQuestion } from '../types';

/**
 * Mobile inbox ordering (#2440). One urgency question is asked per inbox item,
 * over o8-computed facts only — the state carries no card title, summary, or
 * any other worker-written text, and question ids are hashes of the item id.
 *
 * CALIBRATION: PROVISIONAL. No replay has scored this wording yet, so the
 * answer orders a list and nothing else: no threshold reads it, no gate, no
 * auto-decision. The calibration replay (#2438) recalibrates it; record the
 * numbers here when it does.
 */
export const INBOX_QUESTIONS = {
  urgency: {
    type: 'score',
    instructions: 'How urgently does this need the operator? Answer for the item in `items` whose `id` equals this question id.',
    criteria: [
      'Not waiting on anyone: informational, no decision is held by it',
      'Low: it can wait hours, and no work is queued behind it',
      'Moderate: worth handling this session; some work is queued behind it',
      'High: a lane is blocked on this decision right now',
      'Critical: a blocked lane plus risky or time-sensitive work; handle it first',
    ],
  } satisfies ScoreQuestion,
} as const;
