import { noul } from './noul';

/**
 * Push notification gate (#2441, program #2481). Asked once per outgoing push
 * over o8-computed facts only: event kind, lane state, packet outcome, gate
 * result, the approval's stored referee answers, age, whether the event is
 * operator-gated, quiet mode, and the local hour. No title, body, or repo name.
 *
 * CALIBRATION: PROVISIONAL, record-only. No replay has scored this wording.
 * Every push still goes out; the would-suppress decision (not operator-gated
 * and p at or below ABSTAIN_CONFIDENCE) is written to a `push_gate` lane event
 * and read by nothing. The replay label `pushGate` scores it against whether
 * the operator acted on the object within 30 minutes. Record its numbers here.
 */
export const PUSH_GATE_QUESTION = noul("Does this event need the operator's attention now?");
