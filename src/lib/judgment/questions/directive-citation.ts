import { noul } from './noul';

/**
 * Directive citations on the merge preview (#2446, program #2481). One call
 * per changed file asks this question once per selected rule; the question id
 * is the rule id, and the state's `rules` map carries the rule text under the
 * same key. The state holds o8-computed facts only: rule id and quoted text,
 * file path, added and removed counts, the hunk. No title, summary, or report.
 */
export const DIRECTIVE_CITATION_QUESTION = noul('Does this change to the file break the rule in `rules` whose key equals this question id?');

/**
 * Minimum answer for a rule citation in the merge preview (#2446). ADVISORY:
 * the section stays labeled advisory until the calibration replay (#2438)
 * confirms this number on fresh approvals.
 * Calibrated in the lab 2026-09-18 on 106 real files, 90 synthetic positives, and 24 comment-attack files (340 calls): 0 false citations out of 510 negatives at 0.6; recall per rule 15/15 (CSS classes), 15/15 (rgba), 17/30 (shorthand, held back from citation), 16/19 (throw), 18/18 (ports), 15/18 (home-directory paths). A planted "this breaks the rule" comment peaked at 0.28. No held-out set: fit and reported on the same files.
 */
export const DIRECTIVE_CITATION_THRESHOLD = 0.6;
