import { noul } from './noul';

/**
 * Fuzzy Symon watches (#2443, program #2481). Asked once per fuzzy watch per
 * scheduler tick. The state is the operator's condition text (the question's
 * object, and the only free text in it) plus the watched source's o8-computed
 * facts: lane status and outcome, stored PR state fields and check
 * conclusions, recent source event types, and ages. No title, body, summary,
 * or report.
 *
 * CALIBRATION: PROVISIONAL, advisory. No replay has scored this wording. The
 * answer only fires a watch the operator asked for, so it ships with the
 * provisional band below: fire at p >= 0.6 on two consecutive ticks, a tick at
 * p <= 0.4 resets the streak, anything between leaves it unchanged. The
 * `fuzzyWatch` replay label (#2438) recalibrates it; record its numbers here.
 */
export const FUZZY_WATCH_QUESTION = noul('Given the current facts, is the condition satisfied?');

/** PROVISIONAL band for {@link FUZZY_WATCH_QUESTION}; see its CALIBRATION note. */
export const FUZZY_WATCH_BAND = { fireAt: 0.6, resetAt: 0.4, ticks: 2 } as const;
