import { noul } from './noul';

/**
 * Loop detection from tool-call patterns (#2448, program #2481). Asked by the
 * supervisor tick over the last 20 tool calls of an active packet: tool name,
 * a hash of the call's arguments, the head of its output, whether the output
 * reads as an error, and counts. No assistant text, title, or report.
 *
 * CALIBRATION: PROVISIONAL, record-only. No replay has scored this wording.
 * Every answer is recorded as a `loop_check` lane event. An advisory
 * `possible_loop` event and inbox item are raised when two consecutive
 * answers reach the provisional band 1 - ABSTAIN_CONFIDENCE (0.6); an answer
 * at or below ABSTAIN_CONFIDENCE clears the streak. Nothing is stopped. The
 * replay label `loop` (`scripts/judgment-replay.mjs --label loop`) scores the
 * recorded answers; record its numbers here before any threshold acts.
 */
export const LOOP_QUESTION = noul('Is this agent repeating the same actions without progress?');
