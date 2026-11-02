import type { ChoiceQuestion } from '../types';

/**
 * Event triage before an orchestrator wake (#2467, program #2481). Asked once
 * per wake at the three wake chokepoints (review continuation, supervisor
 * escalation, post-rebase verification escalation) over o8-computed facts
 * only: event verb and age, lane status, retry count, attempts, gate result,
 * stored referee answers, and whether an operator decision is pending. No
 * message text, title, brief, or worker-written text reaches the state.
 *
 * CALIBRATION: PROVISIONAL, record-only. No replay has scored this wording.
 * The `wake_triage` lane event is read by nothing: every wake still happens
 * exactly as before. The replay label `wakeTriage` (#2438) recalibrates it
 * against what happened next on the lane; record its numbers here.
 */
export const WAKE_TRIAGE_QUESTION = {
  type: 'choice',
  instructions: 'What does this event need from the orchestrator?',
  criteria: {
    handleInPlace: 'Nothing from the orchestrator: the supervisor, a retry, or a worker steer can handle it where it sits',
    queue: 'Orchestrator attention, but it can wait for the next scheduled turn',
    wake: 'Orchestrator judgment now: wake a fresh orchestrator turn for it',
  },
} as const satisfies ChoiceQuestion<'handleInPlace' | 'queue' | 'wake'>;
