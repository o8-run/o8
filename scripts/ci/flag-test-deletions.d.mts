// Types for the pure helpers in flag-test-deletions.mjs (allowJs is off repo-wide).
export interface NameStatusRecord { status: string; from: string; to: string }
export interface TestRemovals {
  deleted: Array<{ file: string; assertions: number }>;
  weakened: Array<{ file: string; before: number; after: number }>;
  before: number;
  after: number;
  netAssertions: number;
}
export interface TestRemovalVerdict { flagged: boolean; overridden: boolean; failed: boolean }
export declare const OVERRIDE_LABEL: 'tests-removed-ok';
export declare function isTestFile(file: string): boolean;
export declare function stripComments(source: string): string;
export declare function countAssertions(source: string | null | undefined): number;
export declare function parseNameStatus(output: string): NameStatusRecord[];
export declare function findTestRemovals(
  records: NameStatusRecord[],
  readBase: (file: string) => string | null,
  readHead: (file: string) => string | null,
): TestRemovals;
export declare function verdict(result: TestRemovals, labels: string[]): TestRemovalVerdict;
export declare function summarize(result: TestRemovals, outcome: TestRemovalVerdict): string[];
