import { isNetworkThread } from './network-store';

/** Defense against a generic continuation attempting to execute a network transcript. */
export function assertLlmThread(threadId: string | null | undefined) {
  if (threadId && isNetworkThread(threadId)) {
    throw new Error('This is a network thread. Send through its recorded agent exchange.');
  }
}
