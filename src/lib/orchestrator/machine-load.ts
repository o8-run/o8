import os from 'node:os';

/** One-minute OS load includes processes launched outside o8. */
export function machineLoadBlocker(): string | null {
  if (process.platform === 'win32') return null;
  const configured = Number(process.env.O8_DISPATCH_LOAD_PER_CORE ?? '0.5');
  const ratio = Number.isFinite(configured) && configured > 0 ? configured : 0.5;
  const cores = Math.max(1, os.cpus().length);
  const load = os.loadavg()[0];
  if (!Number.isFinite(load) || load < 0) return null;
  const threshold = cores * ratio;
  return load > threshold
    ? `Machine busy: one-minute load ${load.toFixed(2)} exceeds ${threshold.toFixed(2)} for ${cores} cores. Worker queued until load falls.`
    : null;
}

export class MachineLoadDeferredError extends Error {}
