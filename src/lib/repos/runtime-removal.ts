import 'server-only';

const RUNTIME_CLEANUP_TIMEOUT_MS = 3_500;

function normalizeScopePath(filePath?: string | null) {
  const trimmed = filePath?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^~(?=\/|$)/, process.env.HOME ?? '').replace(/\/+$/, '');
}

function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = normalizeScopePath(candidatePath);
  const repo = normalizeScopePath(repoPath);
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

function repoSlugFromRemote(remoteUrl?: string | null) {
  const normalized = remoteUrl?.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/') ?? '';
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

function agentBelongsToRepoScope(
  agent: {
    runtimeSurface?: { cwd?: string | null; reviewContext?: { repoSlug?: string | null } } | null;
    worktree?: { path?: string | null } | null;
    workspace?: string | null;
  },
  repo: { localPath: string; remoteUrl?: string | null; name: string },
) {
  const repoSlug = repoSlugFromRemote(repo.remoteUrl);
  if (repoSlug && agent.runtimeSurface?.reviewContext?.repoSlug === repoSlug) {
    return true;
  }

  const candidatePaths = [
    agent.worktree?.path,
    agent.runtimeSurface?.cwd,
    agent.workspace?.startsWith('/') ? agent.workspace : null,
  ];

  return candidatePaths.some((candidatePath) => pathBelongsToRepoScope(candidatePath, repo.localPath));
}

export async function stopRepoBoundRuntimeSessions(repo: { localPath: string; remoteUrl?: string | null; name: string }) {
  // Project reads also import this module. Load worker adapters only when an
  // actual removal requests runtime confirmation, avoiding their startup cycles.
  const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
  const { performRuntimeAction } = await import('@/lib/runtime/actions');
  const { removeRuntimeTerminalSessionsForRepoPath, getRuntimeTerminalSession } = await import('@/lib/runtime/terminal-session-registry');
  const { killTmuxSession } = await import('@/lib/terminal/tmux');
  const snapshot = await Promise.race([
    getRuntimeInventorySnapshot({ fresh: true }),
    new Promise<Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>>((_, reject) => {
      setTimeout(() => reject(new Error('Runtime inventory timed out.')), RUNTIME_CLEANUP_TIMEOUT_MS);
    }),
  ]).catch(() => null);
  if (!snapshot) {
    return {
      ok: false,
      targetedSessionCount: 0,
      stoppedSessionCount: 0,
      removedTerminalBindings: 0,
      note: 'Runtime inventory was unavailable; repository removal was not started.',
    };
  }
  const targetAgents = snapshot?.agents.filter((agent) => agentBelongsToRepoScope(agent, repo)) ?? [];
  const stoppedSessionKeys = new Set<string>();

  await Promise.all(targetAgents.map(async (agent) => {
    try {
      const result = await Promise.race([
        performRuntimeAction({
          action: 'stop',
          surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
        }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), RUNTIME_CLEANUP_TIMEOUT_MS);
        }),
      ]);
      if (result?.ok) stoppedSessionKeys.add(agent.sessionKey);
    } catch {
      return;
    }

    const terminalBinding = getRuntimeTerminalSession(agent.sessionKey);
    if (terminalBinding?.sessionName) {
      await Promise.race([
        killTmuxSession(terminalBinding.sessionName).catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, RUNTIME_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    }
  }));

  if (stoppedSessionKeys.size !== targetAgents.length) {
    return {
      ok: false,
      targetedSessionCount: targetAgents.length,
      stoppedSessionCount: stoppedSessionKeys.size,
      removedTerminalBindings: 0,
      note: 'One or more repo-bound runtime sessions could not be confirmed stopped.',
    };
  }

  const removedTerminalBindings = removeRuntimeTerminalSessionsForRepoPath(repo.localPath);

  return {
    ok: true,
    targetedSessionCount: targetAgents.length,
    stoppedSessionCount: stoppedSessionKeys.size,
    removedTerminalBindings: removedTerminalBindings.length,
  };
}

/** A refused stop must abort project deletion before any project/link writes. */
export class RepoRuntimeStopUnconfirmed extends Error {
  constructor(public readonly cleanup: Awaited<ReturnType<typeof stopRepoBoundRuntimeSessions>>) {
    super('repo_runtime_stop_unconfirmed');
  }
}
