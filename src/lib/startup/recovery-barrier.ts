/**
 * The WS server's crash-recovery sweeps (worktree reaper, branch pruning,
 * dependency-image and workspace reconciliation) read what they find on disk
 * as leftovers of the last run. They now run after the server is ready, so a
 * request must not create a worktree while they do: creation waits here.
 * Nothing else holds the barrier, so outside that window it is open.
 */
let barrier: Promise<void> = Promise.resolve();

/** Close the barrier; the returned function opens it again. */
export function holdForStartupRecovery(): () => void {
  let open!: () => void;
  barrier = new Promise((resolve) => { open = resolve; });
  return () => open();
}

export function startupRecoveryDone(): Promise<void> {
  return barrier;
}
