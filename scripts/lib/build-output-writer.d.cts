import type { ExactDirectoryManifestEntry } from '../../src/lib/workspace/exact-directory-purge';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export interface BuildOutputWriter {
  api: typeof import('node:fs');
  promises: typeof import('node:fs/promises');
  admit(pid: number, identity: MetadataLockProcessIdentity): void;
  observedClose(pid: number, identity: MetadataLockProcessIdentity): void;
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  prove(entries: ExactDirectoryManifestEntry[]): void;
  promote(destination: { canonicalPath: string; device: number; inode: number }, entries: ExactDirectoryManifestEntry[]): ExactDirectoryManifestEntry[];
  close(): void;
}
export function createBuildOutputWriter(scope: string, expected: { device: number; inode: number }): BuildOutputWriter;
