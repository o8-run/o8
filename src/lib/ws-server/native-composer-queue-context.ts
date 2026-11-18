import { isNetworkThread } from '@/lib/bots/network-store';
import { validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { ORCHESTRATOR_BACKEND_IDS } from '@/lib/lane/orchestrator-backends/types';

export const COMPOSER_QUEUE_GRANT_LIMIT = 1024 * 1024;
const MAX_BACKEND_BYTES = 64;
const MAX_TARGET_BYTES = 16 * 1024;

/** Node owns validation and runtime capability discovery. This context exists
 * only for the authenticated admission of this exact request; never cache it. */
export function nativeComposerQueueContext(url: URL) {
  if (url.searchParams.has('id')) return null;
  const request = { repoPath: url.searchParams.get('repoPath'), threadId: url.searchParams.get('threadId'), backend: url.searchParams.get('backend') };
  if (request.repoPath === null || request.threadId === null) return null;
  try {
    if (isNetworkThread(request.threadId)) return null;
    const target = validateComposerQueueTarget(request, false);
    if ([request.repoPath, target.repoPath].some(s => Buffer.byteLength(s) > MAX_TARGET_BYTES)
      || Buffer.byteLength(target.threadId) > 256) return null;
    if (request.backend !== null && Buffer.byteLength(request.backend) > MAX_BACKEND_BYTES) return null;
    const capabilities = ORCHESTRATOR_BACKEND_IDS.map(id => ({ id, liveSteer: Boolean(getOrchestratorBackend(id, target).liveSteer) }));
    return { target, request, capabilities };
  } catch { return null; }
}
export function composerQueueGrant(defaultsContext: object): string | null {
  const body = JSON.stringify({ version: 1, defaultsContext });
  return Buffer.byteLength(body) <= COMPOSER_QUEUE_GRANT_LIMIT ? body : null;
}
