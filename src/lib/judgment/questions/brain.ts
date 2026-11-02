import type { ChoiceQuestion } from '../types';

/** Engineering Brain question routing (#2436). */
export const BRAIN_CLASS_QUESTIONS = {
  // Mean latency 230 ms over 24 labeled questions (354 input tokens per call).
  questionClass: {
    type: 'choice',
    instructions: 'Classify the engineering question.',
    criteria: {
      classA: 'Lookup ("who/when/where/what"): a 1-2 fact answer, deterministic',
      classB: 'Reasoning ("why/how/explain"): multi-fact composition required',
    },
  } satisfies ChoiceQuestion<'classA' | 'classB'>,
} as const;
