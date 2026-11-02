import type { NoulQuestion } from '../types';
import { noul } from './noul';

/**
 * Judgment-scored compaction (#2465). One locked question, asked once per
 * compacted transcript entry in a single call; the question ids are
 * `entry_<entry id>` and each state entry names its question id. The state is
 * o8-computed facts and the text the summarizer already sees, nothing else.
 *
 * CALIBRATION: PROVISIONAL, record-only. No replay has scored this wording.
 * The scores and keep / drop / summarize bands are written to the compaction
 * record and read by nothing; the compaction replay label (#2438) scores them
 * against the identifiers later turns reuse. Record its numbers here.
 */
export const COMPACTION_ENTRY_QUESTION = noul('Is this entry needed to continue the current task? Answer for the entry in `entries` whose `question` equals this question id.');

/** One copy of the locked compaction question per question id. */
export function compactionQuestions(questionIds: readonly string[]): Record<string, NoulQuestion> {
  return Object.fromEntries(questionIds.map((id) => [id, COMPACTION_ENTRY_QUESTION]));
}
