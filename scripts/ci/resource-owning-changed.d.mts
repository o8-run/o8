// Types for the pure helpers in resource-owning-changed.mjs (allowJs is off repo-wide).
export declare const WORKFLOW_MIRROR_TESTS: string[];
export declare const ENUMERATING_SUITES: string[];
export declare function unclassifiedEnumeratingSuites(classification: { resourceOwning?: Array<{ path: string }> }, exists?: (path: string) => boolean): string[];
export declare function parseNameStatus(output: string): string[];
export declare function selectResourceOwning(
  changedPaths: string[],
  classification: { resourceOwning?: Array<{ path: string }> },
): string[];
