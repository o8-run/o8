import os from 'node:os';
import { listActiveLanes } from '@/lib/lane/registry';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';

export interface MachineLoadOptions {
  readLoad?: () => number[];
  runningWorkers?: number;
  ratio?: number;
  force?: boolean;
}

/** Tests opt into load explicitly; production samples the five-minute figure. */
export function machineLoadBlocker(options: MachineLoadOptions = {}): string | null {
  if (options.force || process.platform === 'win32') return null;
  const readLoad = options.readLoad ?? (process.env.VITEST ? () => [0, 0, 0] : () => os.loadavg());
  const running = options.runningWorkers ?? listActiveLanes().filter(lane => lane.status === 'running' || lane.status === 'launching').length;
  if (running === 0) return null;
  const configured = Number(options.ratio ?? getOperatorDefaultsSync().values.dispatchLoadPerCore);
  const ratio = Number.isFinite(configured) && configured >= 0 ? configured : 1.5;
  if (ratio === 0) return null;
  const cores = Math.max(1, os.availableParallelism());
  const load = readLoad()[1];
  const threshold = cores * ratio;
  return Number.isFinite(load) && load > threshold
    ? `Machine busy: five-minute load ${load.toFixed(2)} exceeds ${threshold.toFixed(2)} for ${cores} cores. Worker queued until load falls.`
    : null;
}

export class MachineLoadDeferredError extends Error {}
