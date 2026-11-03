// Types for the pure helpers in resource-owning-changed.mjs (allowJs is off repo-wide).
export declare const WORKFLOW_MIRROR_TESTS: string[];
export declare function parseNameStatus(output: string): string[];
export declare function selectResourceOwning(
  changedPaths: string[],
  classification: { resourceOwning?: Array<{ path: string }> },
): string[];
