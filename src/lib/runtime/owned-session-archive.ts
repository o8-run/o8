import type { OwnedArchiveResponse } from '@/lib/runtimes/shared/owned-session/types';
import { getRuntime } from '@/lib/runtimes';
import { persistRuntimeSessionCost } from '@/lib/orchestrator/cost-persistence';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import { readOwnedSessionRecord } from '@/lib/runtimes/shared/owned-session-index';
import { matchesMutationWorkspace, MutationWorkspaceNotFoundError } from '@/lib/repos/mutation-workspace';

async function persistOwnedSessionCostBeforeArchive(sessionKey: string) {
  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  const adapter = runtimeId ? getRuntime(runtimeId) : null;
  if (!runtimeId || !adapter?.capabilities.costTelemetry) return;
  const session = (await adapter.discoverSessions().catch(() => []))
    .find((candidate) => candidate.sessionKey === sessionKey);
  await persistRuntimeSessionCost({
    sessionKey,
    runtime: runtimeId,
    repoPath: session?.cwd ?? process.cwd(),
  });
}

/** Archive any registered or built-in owned runtime session by its durable key. */
export async function archiveOwnedRuntimeSession(
  sessionKey: string,
  workspace?: string,
): Promise<OwnedArchiveResponse | null> {
  await import('@/lib/runtimes');
  if (workspace !== undefined) {
    const session = await readOwnedSessionRecord(sessionKey);
    if (!session || !matchesMutationWorkspace(workspace, session.repoPath)) throw new MutationWorkspaceNotFoundError();
  }
  await persistOwnedSessionCostBeforeArchive(sessionKey);
  const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
  const registered = getOwnedSessionLifecycle(sessionKey);
  if (registered) return registered.archiveSession(sessionKey, workspace);
  if (workspace !== undefined) throw new MutationWorkspaceNotFoundError();
  if (sessionKey.startsWith('codex-owned:')) {
    return import('@/lib/codex/owned').then(({ archiveOwnedCodexSession }) => archiveOwnedCodexSession(sessionKey));
  }
  if (sessionKey.startsWith('claude-code-owned:')) {
    return import('@/lib/claude-code/owned').then(({ archiveOwnedClaudeCodeSession }) => archiveOwnedClaudeCodeSession(sessionKey));
  }
  if (sessionKey.startsWith('gemini-owned:')) {
    return import('@/lib/gemini/owned').then(({ archiveOwnedGeminiSession }) => archiveOwnedGeminiSession(sessionKey));
  }
  if (sessionKey.startsWith('opencode-owned:')) {
    return import('@/lib/opencode/owned').then(({ archiveOwnedOpencodeSession }) => archiveOwnedOpencodeSession(sessionKey));
  }
  if (sessionKey.startsWith('cursor-owned:')) {
    return import('@/lib/cursor/owned').then(({ archiveOwnedCursorSession }) => archiveOwnedCursorSession(sessionKey));
  }
  if (sessionKey.startsWith('grok-owned:')) {
    return import('@/lib/grok/owned').then(({ archiveOwnedGrokSession }) => archiveOwnedGrokSession(sessionKey));
  }
  if (sessionKey.startsWith('pi-owned:')) {
    return import('@/lib/pi/owned').then(({ archiveOwnedPiSession }) => archiveOwnedPiSession(sessionKey));
  }
  if (sessionKey.startsWith('prime-agent-owned:')) {
    return import('@/lib/prime-agent/owned').then(({ archiveOwnedPrimeAgentSession }) => archiveOwnedPrimeAgentSession(sessionKey));
  }
  return null;
}
