export type UpdateAutoApply = 'off' | 'idle';

/** Server state imports this without loading the client update hub. */
export interface AppUpdateBlockers {
  /** Work a restart would interrupt. A restart waits for it. */
  live: string[];
  /** Tasks waiting for review or input. A confirmed restart keeps their state. */
  parked: string[];
}
