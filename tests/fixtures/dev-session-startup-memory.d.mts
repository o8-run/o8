export interface DevSessionMemoryReceipt {
  peakMiB: number;
  elapsedMs: number;
  error: string | null;
  dashboard?: boolean;
  dashboardRevisit?: boolean;
  serverProcessCount: number;
  renderedIcons?: boolean;
  threadCount?: number;
  histories?: Array<{ session: number; rows: number; finalRowPresent: boolean }>;
  persistedRows: number[];
}
export function measureDevSessionStartup(workspace: string, output: string, registerCleanup?: (cleanup: () => void) => void): Promise<DevSessionMemoryReceipt>;
