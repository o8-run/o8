/** Bound the wait even when a transport or body reader does not settle on abort. */
export async function withGitHubAbort<T>(signal: AbortSignal | null | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try { pending = work(); }
    catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
    pending.then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
