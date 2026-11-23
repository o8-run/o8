import { holdForStartupRecovery } from '@/lib/startup/recovery-barrier';

/**
 * Requests wait only for `ready`: what a handler needs to answer correctly.
 * Maintenance starts once the server is ready, and worktree creation waits on
 * the recovery barrier until it is done (or has failed).
 */
export function runStartupSequence(steps: {
  ready: () => Promise<void>;
  maintenance: () => Promise<void>;
}): { ready: Promise<void>; recovered: Promise<void> } {
  const openRecovery = holdForStartupRecovery();
  const ready = steps.ready();
  const recovered = ready.then(() => steps.maintenance()).finally(openRecovery);
  return { ready, recovered };
}
