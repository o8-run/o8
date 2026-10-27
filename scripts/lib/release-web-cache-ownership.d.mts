import type { ExactDirectoryManifest } from '../../src/lib/workspace/exact-directory-purge';
export interface RestoredWebCacheOwnership {
  path: string;
  identity: { device: number; inode: number };
  manifest: ExactDirectoryManifest;
}
export function captureRestoredWebCache(source: string, destination: string): Promise<RestoredWebCacheOwnership>;
export function prepareRegisteredWebCache(root: string, compiler: string, ownership?: RestoredWebCacheOwnership | null): Promise<void>;
