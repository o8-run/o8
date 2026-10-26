import { prepareOwnedWorkerMcpConfig, type PreparedOwnedWorkerMcpConfig } from './worker-mcp-config';
import { prepareWorkerO8Cli, type PreparedWorkerO8Cli } from './worker-o8-cli';
import type {
  OwnedRunMode,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';

export interface PreparedOwnedLaunchArgs {
  args: string[];
  stdinPayload: string | null;
  workerMcp: PreparedOwnedWorkerMcpConfig;
  workerO8BinDir?: string;
  workerO8ReadPaths: string[];
  workerO8?: PreparedWorkerO8Cli;
}

export async function prepareOwnedLaunchArgs({
  adapter,
  session,
  runId,
  prompt,
  mode,
  sandboxEnabled,
  humanLabel,
  artifactRoot,
}: {
  adapter: OwnedRuntimeAdapter;
  session: OwnedSessionRecord;
  runId: string;
  prompt: string;
  mode: OwnedRunMode;
  sandboxEnabled: boolean;
  humanLabel: string;
  artifactRoot?: string;
}): Promise<PreparedOwnedLaunchArgs> {
  const workerO8 = await prepareWorkerO8Cli(session, runId, artifactRoot);
  try {
    if (workerO8) prompt += '\n\nThe o8 command on PATH is verified for this run. Use o8 packet commands directly; do not construct source-loader wrappers.';
    const workerMcp = await prepareOwnedWorkerMcpConfig({
      adapter,
      session,
      runId,
      mode,
      sandboxEnabled,
    });
    workerMcp.sandboxReadPaths.push(...(workerO8?.readPaths ?? []));

    if (mode === 'launch') {
      return {
        args: adapter.launchArgs({
          cwd: session.repoPath,
          sessionDir: session.sessionDir,
          prompt,
          model: session.model,
          effort: session.effort,
          workerMcpConfigPath: workerMcp.configPath,
          workerMcpServers: workerMcp.servers,
          runtimeConfig: session.runtimeConfig,
        }),
        stdinPayload: adapter.launchStdin?.({
          cwd: session.repoPath,
          prompt,
          model: session.model,
          effort: session.effort,
        }) ?? null,
        workerMcp,
        workerO8BinDir: workerO8?.binDir,
        workerO8ReadPaths: workerO8?.readPaths ?? [],
        workerO8: workerO8 ?? undefined,
      };
    }

    const args = adapter.resumeArgs({
      threadId: session.threadId ?? '',
      sessionDir: session.sessionDir,
      prompt,
      model: session.model,
      effort: session.effort,
      workerMcpConfigPath: workerMcp.configPath,
      workerMcpServers: workerMcp.servers,
      // A resumed read-only packet must stay read-only: the pin lives on the
      // session, so the mode survives even when the resume caller knows nothing.
      runtimeConfig: session.runtimeConfig,
    });
    if (!args) {
      throw new Error(`Resume is not supported by the ${humanLabel} runtime adapter.`);
    }
    return {
      args,
      stdinPayload: adapter.resumeStdin?.({
        cwd: session.repoPath,
        prompt,
        model: session.model,
        effort: session.effort,
      }) ?? null,
      workerMcp,
      workerO8BinDir: workerO8?.binDir,
      workerO8ReadPaths: workerO8?.readPaths ?? [],
      workerO8: workerO8 ?? undefined,
    };
  } catch (error) {
    await workerO8?.cleanupUnstarted(true).catch(() => {});
    throw error;
  }
}
