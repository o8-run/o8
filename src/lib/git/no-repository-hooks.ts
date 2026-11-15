import { devNull } from 'node:os';

/**
 * Leading `git` arguments for Git o8 runs while it refreshes, pushes or merges
 * a lane: no repository hooks and no filesystem monitor, whichever checkout or
 * clone the command runs in.
 */
export const NO_REPOSITORY_HOOKS: readonly string[] = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];
