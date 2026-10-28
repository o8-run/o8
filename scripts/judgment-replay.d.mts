// Types for judgment-replay.mjs (allowJs is off repo-wide). The test drives
// runReplay in-process so a fetch spy can prove --dry-run sends nothing.
export interface ReplayIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Test fixture endpoint; the command line has no endpoint flag. */
  endpoint?: string;
  retryBaseMs?: number;
}
export interface ReplayOptions {
  dryRun: boolean;
  limit: number | null;
  out: string | null;
  label: string | null;
  help?: boolean;
}
export declare function parseReplayArgs(argv: string[]): { options: ReplayOptions; error?: undefined } | { error: string; options?: undefined };
export declare function runReplay(argv: string[], io?: ReplayIo): Promise<number>;
