// Types for red-baseline.mjs (allowJs is off repo-wide).
export declare function loadRedBaseline(path: string | undefined, ref?: string, cwd?: string): Set<string> | null;
export declare function classifyAgainstBaseline(
  results: Array<{ file: string; failed: boolean }>,
  baseline: Set<string> | null,
): { ran: number; green: string[]; baselineRed: string[]; newRed: string[]; nowGreen: string[] };
