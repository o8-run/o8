import { writeFileSync } from 'node:fs';
import { withMcpConfigPolicy } from '@/lib/providers/mcp-config-policy';
import { readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { recordLaneEvent } from '@/lib/lane/events';
import {
  resolveWorkerMcpInjection,
  type ResolvedWorkerMcpServer,
} from '@/lib/mcp/worker-injection';

import type { OwnedRunMode, OwnedRuntimeAdapter, OwnedSessionRecord } from './types';
import { installedTool } from '@/lib/devices/tools';
import { getDeviceManager } from '@/lib/devices/service';
import { devMcpServerLaunch, findBundledMcpServer, resolveToolSpineApiBase } from '@/lib/mcp/tool-spine/build';
import { fileURLToPath } from 'node:url';
import { guardWorkerMcpLaunch } from '@/lib/providers/mcp-worker-launch';

export interface PreparedOwnedWorkerMcpConfig {
  configPath?: string;
  sandboxReadPaths: string[];
  servers: ResolvedWorkerMcpServer[];
}

function recordWorkerMcpEvent(
  session: OwnedSessionRecord,
  verb: 'mcp_injected' | 'mcp_injection_skipped',
  payload: Record<string, unknown>,
): void {
  if (!session.laneId) return;
  try {
    recordLaneEvent(session.laneId, verb, 'system', payload);
  } catch (error) {
    console.warn(`[owned-session] unable to record ${verb} for ${session.laneId}:`, error);
  }
}

export async function prepareOwnedWorkerMcpConfig({
  adapter,
  session,
  runId,
  mode,
  sandboxEnabled,
}: {
  adapter: OwnedRuntimeAdapter;
  session: OwnedSessionRecord;
  runId: string;
  mode: OwnedRunMode;
  sandboxEnabled: boolean;
}): Promise<PreparedOwnedWorkerMcpConfig> {
  if (session.executionPolicy !== undefined) {
    if (adapter.workerMcpInjection !== 'config-file') return { sandboxReadPaths: [], servers: [] };
    const configPath = path.join(session.sessionDir, `o8-worker-mcp-${runId}.json`);
    await writeFile(configPath, '{"mcpServers":{}}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { configPath, sandboxReadPaths: [configPath], servers: [] };
  }
  if (!session.packetId || !adapter.workerMcpInjection) {
    return { sandboxReadPaths: [], servers: [] };
  }

  // Preserve operator PATH precedence when resolving a configured command;
  // the server's Node directory is a fallback for interpreter availability.
  const commandPath = [process.env.PATH, path.dirname(process.execPath)].filter(Boolean).join(path.delimiter);
  const resolution = await resolveWorkerMcpInjection({
    packetId: session.packetId,
    worktreePath: session.repoPath,
    branch: session.branch ?? '',
    laneId: session.laneId,
  }, {
    resolveCommands: true,
    pathValue: commandPath,
  });
  for (const skipped of resolution.skipped) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', skipped);
  }
  if (resolution.error) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', {
      reason: `Unable to load operator-registered MCP servers: ${resolution.error}`,
    });
    return { sandboxReadPaths: [], servers: [] };
  }
  // Installed controls attach automatically. This never installs or starts a helper,
  // and the transport inherits only the packet credential from the worker process.
  if (await installedTool(getDeviceManager().root, 'agent')) {
    const bundled = findBundledMcpServer('operator-mcp-proxy.mjs');
    const launch = bundled ? { command: process.execPath, args: [bundled] }
      : devMcpServerLaunch(fileURLToPath(new URL('../../../mcp/operator-mcp-proxy.ts', import.meta.url)));
    resolution.servers.push({ id: 'builtin:devices', name: 'o8-devices', ...launch,
      env: { O8_DEVICE_WORKER_ONLY: '1', O8_DEVICE_CONVERSATION_ID: session.threadId ?? session.packetId,
        O8_API_BASE: resolveToolSpineApiBase(), O8_DATA_DIR: path.dirname(getDeviceManager().root), O8_MCP_TOOL_LOADING: 'full' } });
  }
  if (resolution.servers.length === 0) return { sandboxReadPaths: [], servers: [] };

  let injectableServers: ResolvedWorkerMcpServer[];
  try {
    injectableServers = resolution.servers.map(server => guardWorkerMcpLaunch(server, session.sessionDir, session.repoPath, commandPath));
  } catch {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', { reason: 'MCP executable changed or could not be resolved. Retry the launch.' });
    return { sandboxReadPaths: [], servers: [] };
  }
  const commandReadPaths = sandboxEnabled
    ? [...new Set((await Promise.all(injectableServers.map(async (server) => [
      path.dirname(server.command),
      path.dirname(await realpath(server.command)),
      ...(server.executable ? [path.dirname(server.executable.alias), path.dirname(server.executable.target)] : []),
    ]))).flat())]
    : [];
  if (adapter.workerMcpInjection === 'config-override') {
    recordWorkerMcpEvent(session, 'mcp_injected', {
      servers: injectableServers.map((server) => server.name),
      mode,
    });
    return {
      sandboxReadPaths: commandReadPaths,
      servers: injectableServers,
    };
  }

  try {
    const configPath = path.join(session.sessionDir, `o8-worker-mcp-${runId}.json`);
    const staleConfigNames = (await readdir(session.sessionDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^o8-worker-mcp-.*\.json$/.test(entry.name))
      .map((entry) => entry.name);
    await Promise.all(staleConfigNames.map((name) => unlink(path.join(session.sessionDir, name))));
    const mcpServers = Object.fromEntries(injectableServers.map((server) => [
      server.name,
      {
        command: server.command,
        args: server.args,
        env: server.env ?? {},
      },
    ]));
    withMcpConfigPolicy({ mcpServers }, adapter.runtimeId, () => writeFileSync(
      configPath,
      `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    ), session.repoPath);
    recordWorkerMcpEvent(session, 'mcp_injected', {
      servers: injectableServers.map((server) => server.name),
      configPath,
      mode,
    });
    return {
      configPath,
      sandboxReadPaths: sandboxEnabled
        ? [configPath, ...commandReadPaths]
        : [],
      servers: injectableServers,
    };
  } catch (error) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', {
      servers: injectableServers.map((server) => server.name),
      reason: error instanceof Error ? error.message : String(error),
    });
    return { sandboxReadPaths: [], servers: [] };
  }
}
