/**
 * Locked judgment question texts (#2434).
 *
 * Wording is an API. A calibration run on 2026-09-17 showed that rewording one
 * question moved its answer on the same diff by up to 0.44, so any threshold
 * set against these answers is only valid for this exact text. Change an
 * instruction or criterion string only together with a calibration rerun
 * (#2438), and record the new numbers in the comment above the question.
 */

// Compatibility exports for existing callers. New surfaces own and import their
// question module directly; adding a surface does not require editing this file.
export { DIFF_QUESTIONS, DIFF_QUESTION_USE, DOCS_ONLY_CHIP_THRESHOLD } from './questions/diff';
export { INBOX_QUESTIONS } from './questions/inbox';
export { BRAIN_CLASS_QUESTIONS } from './questions/brain';
export { REPORT_QUESTIONS } from './questions/report';
export { COMPACTION_ENTRY_QUESTION, compactionQuestions } from './questions/compaction';
export { DIRECTIVE_CITATION_QUESTION, DIRECTIVE_CITATION_THRESHOLD } from './questions/directive-citation';
export { PUSH_GATE_QUESTION } from './questions/push-gate';
export { LOOP_QUESTION } from './questions/loop';
export { CATCH_UP_QUESTION, catchUpQuestions } from './questions/catch-up';
export { WAKE_TRIAGE_QUESTION } from './questions/wake-triage';
export { FUZZY_WATCH_QUESTION, FUZZY_WATCH_BAND } from './questions/fuzzy-watch';
