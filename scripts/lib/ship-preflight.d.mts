export interface ShipCommandReceipt {
  status: number;
  stdout: string;
  stderr: string;
  pid?: number | null;
}

export interface ShipPreflightReceipt {
  schema: 'o8/release-preflight/v1';
  head: string;
  version: string;
  tag: string;
  remoteTagHead: string;
  releaseAbsent: boolean;
  availableGiB: number;
  minFreeGiB: number;
  credentialNames: string[];
  releaseConfigKeys: string[];
  signingKeyPresent: boolean;
  intakeReconciliation:
    | { schema: 'o8/intake-reconciliation/v1'; status: 'configured'; source: 'environment' | 'runtime-file' }
    | { schema: 'o8/intake-reconciliation/v1'; status: 'disabled' }
    | { schema: 'o8/intake-reconciliation/v1'; status: 'missing' | 'misconfigured'; reason: string };
  toolchains: Record<string, string>;
}

export interface QuickBenchmarkCleanup {
  confirmed: boolean;
  stoppedProcesses: number;
  removedOutput: boolean;
  reason?: string;
  outputError?: string;
}

export interface QuickBenchmarkPreflightReceipt {
  schema: 'o8/benchmark-quick-preflight/v1';
  status: 'ok' | 'regressed' | 'incomplete' | 'unavailable';
  regressions: Array<{ name: string; deltaValue: number | null }>;
  missing: string[];
  message?: string;
  durationMs?: number;
  version?: string;
  gitSha?: string;
  target?: {
    appVersion: string | null;
    buildGitSha: string | null;
    buildMode: string | null;
    platform: string | null;
    unavailableReason: string | null;
  } | null;
  comparedTo?: string | null;
  resultPath?: string | null;
  cleanup?: QuickBenchmarkCleanup & { recoveredPrevious?: QuickBenchmarkCleanup[] };
}

export function commandReceipt(command: string, args: string[], options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  detached?: boolean;
}): ShipCommandReceipt;
export function acquireReleaseLock(options?: { lockPath?: string }): {
  path: string;
  release(): void;
};
export function performShipPreflight(options: {
  root: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => ShipCommandReceipt;
}): ShipPreflightReceipt;
export function runQuickBenchmarkPreflight(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: (command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    detached?: boolean;
  }) => ShipCommandReceipt;
}): QuickBenchmarkPreflightReceipt;

export const shipPreflightInternals: {
  benchmarkStatePath(root: string): string;
} & Record<string, unknown>;
