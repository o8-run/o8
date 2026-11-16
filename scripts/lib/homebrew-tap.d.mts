export declare const HOMEBREW_TAP: string;
export declare function requestHomebrewBump(
  version: string,
  exec?: (file: string, args: string[], options: { stdio: 'pipe' }) => unknown,
): { requested: boolean; reason: string | null };
