import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

// A model call made for a caller other than the operator answers from its
// prompt alone: Claude starts with no tools, and Codex, which has no mode
// without a shell, is not launched.
const scope = new AsyncLocalStorage<true>();

/** True while serving a caller whose model calls must run without tools. */
export function modelToolsWithheld(): boolean {
  return scope.getStore() === true;
}

/** Run `fn` so every model call it makes runs without tools. */
export function withModelToolsWithheld<T>(fn: () => T): T {
  return scope.run(true, fn);
}
