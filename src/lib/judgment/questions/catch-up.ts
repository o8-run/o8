import type { NoulQuestion } from '../types';
import { noul } from './noul';

/**
 * Catch-up ranking for the phone briefing (#2444, program #2481). One copy of
 * this question per briefing item in a single call; the question ids are
 * hashes of the item id, and each state item names its question id. The
 * state is o8-computed facts only: kind, lane state, age, gate result, the
 * stored merge-card referee facts, whether the operator gates it, and a repo
 * index. No title, summary, commit message, or worker-written text.
 *
 * CALIBRATION: PROVISIONAL, no threshold. The score is an ordering key and
 * nothing else: it moves briefing lines within their section, and every
 * failure keeps event order. No gate or decision reads it. The replay label
 * `catchUp` (#2438) scores it later; record its numbers here.
 */
export const CATCH_UP_QUESTION = noul("How much does this change need the operator's attention? Answer for the item in `items` whose `question` equals this question id.");

/** One copy of the locked catch-up question per question id. */
export function catchUpQuestions(questionIds: readonly string[]): Record<string, NoulQuestion> {
  return Object.fromEntries(questionIds.map((id) => [id, CATCH_UP_QUESTION]));
}
