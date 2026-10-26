export const SMOKE_STEPS: readonly string[];
export function fileSha256(path: string): string;
export function manifestSha256(manifest: unknown): string;
export function requireSmokeReceipts(manifest: unknown, paths: string[]): void;
