/** GraphQL run states combine REST status and terminal conclusions. Unknown states fail closed. */
const FINISHED_RUN_STATES = new Set(['COMPLETED', 'SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE']);
export const isUnfinishedCheckRunState = (state: string) => !FINISHED_RUN_STATES.has(state.toUpperCase());
export const isPendingStatusContext = (state: string) => ['PENDING', 'EXPECTED'].includes(state.toUpperCase());
