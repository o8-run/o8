import { runWithProviderInstance } from './instance-context';
import { resolveProviderInstanceLaunch } from './instances';

/** Runs one turn inside the thread's provider instance; default threads run unchanged. */
export function runWithThreadProviderInstance<T>(backendId: string, threadId: string | null | undefined, operation: () => Promise<T>): Promise<T> {
  let instance;
  try { instance = resolveProviderInstanceLaunch(threadId, backendId === 'claude' ? 'claude-code' : backendId); }
  catch (error) { return Promise.reject(error); }
  return instance ? runWithProviderInstance(instance, operation) : operation();
}
