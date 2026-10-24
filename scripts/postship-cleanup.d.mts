export const POSTSHIP_GENERATED_DIRS: string[];
export const POSTSHIP_PRESERVED_DIRS: string[];

export interface PostshipCleanupResult {
  removed: string[];
  skipped: string[];
  refused: Array<{ path: string; reason: string }>;
}

export function cleanupPostshipOutputs(repoRoot?: string,
  options?: { symbolsRoot?: string }): Promise<PostshipCleanupResult>;
export function assertGeneratedTreeHasSafeLinks(root: string, rootAlias: string,
  target: string, relativePath: string): Promise<void>;
