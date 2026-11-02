import type { NoulQuestion } from '../types';

export const noul = (instructions: string): NoulQuestion => ({ type: 'noul', instructions });
