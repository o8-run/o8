import { assertMcpTransport } from '@/lib/providers/mcp-launch-policy';
import { access, constants as fsConstants, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  listEnabledExternalMcpServers,
  type ExternalMcpServerRecord,
} from '@/lib/mcp/external-servers';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export const WORKER_MCP_INJECTION_SUPPORTED_RUNTIMES: ReadonlySet<OrchestratorRuntime> = new Set([
  'claude-code',
  'codex',
]);

const WORKER_MCP_CONFIG_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function workerMcpInjectionSupported(runtime: OrchestratorRuntime): boolean {
  return WORKER_MCP_INJECTION_SUPPORTED_RUNTIMES.has(runtime);
}

export function workerMcpServerNameIsValid(name: string): boolean {
  return WORKER_MCP_CONFIG_KEY_PATTERN.test(name);
}

export interface WorkerMcpInjectionContext {
  packetId: string;
  worktreePath: string;
  branch: string;
  laneId?: string | null;
  teamId?: string | null;
}

export interface ResolvedWorkerMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string> | null;
}

export interface WorkerMcpInjectionResolution {
  servers: ResolvedWorkerMcpServer[];
  skipped: Array<{ server: string; command: string; reason: string }>;
  error?: string;
}

export interface ResolveWorkerMcpInjectionOptions {
  resolveCommands?: boolean;
  pathValue?: string;
}

const TEMPLATE_VALUES = new Set(['packetId', 'worktreePath', 'branch', 'laneId']);

function templateEnvValue(value: string, context: WorkerMcpInjectionContext): string {
  return value.replace(/\{\{([^{}]+)\}\}/g, (token, rawKey: string) => {
    const key = rawKey.trim();
    if (!TEMPLATE_VALUES.has(key)) return token;
    const replacement = context[key as keyof WorkerMcpInjectionContext];
    return typeof replacement === 'string' ? replacement : token;
  });
}

export function templateWorkerMcpServer(
  server: ExternalMcpServerRecord,
  context: WorkerMcpInjectionContext,
): ResolvedWorkerMcpServer {
  const env = server.env
    ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => (
        [key, templateEnvValue(value, context)]
      )))
    : null;
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: [...server.args],
    env,
  };
}

/** Resolve the operator-owned worker attachment set for one packet context. */
export async function resolveWorkerMcpInjection(
  context: WorkerMcpInjectionContext,
  options: ResolveWorkerMcpInjectionOptions = {},
): Promise<WorkerMcpInjectionResolution> {
  try {
    const configuredServers = listEnabledExternalMcpServers()
      .filter((server) => (
        server.transport === 'stdio'
        && server.workerInjection
        && (server.teamId === null || server.teamId === context.teamId)
      ))
      .map((server) => templateWorkerMcpServer(server, context));
    const validServers: ResolvedWorkerMcpServer[] = [];
    const skipped: WorkerMcpInjectionResolution['skipped'] = [];
    for (const server of configuredServers) {
      try { assertMcpTransport([server.id, server.name, server.command]); }
      catch { skipped.push({ server: '[redacted]', command: '[redacted]', reason: 'MCP server metadata contains a saved credential.' }); continue; }
      if (workerMcpServerNameIsValid(server.name)) {
        validServers.push(server);
      } else {
        skipped.push({
          server: server.name,
          command: server.command,
          reason: 'name is not a valid config key',
        });
      }
    }
    if (!options.resolveCommands) return { servers: validServers, skipped };

    const servers: ResolvedWorkerMcpServer[] = [];
    for (const server of validServers) {
      try {
        servers.push({
          ...server,
          command: await resolveWorkerMcpCommand(
            server.command,
            context.worktreePath,
            options.pathValue ?? process.env.PATH ?? '',
          ),
        });
      } catch (error) {
        skipped.push({
          server: server.name,
          command: server.command,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { servers, skipped };
  } catch (error) {
    return {
      servers: [],
      skipped: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve a configured stdio command to the executable admitted by the sandbox. */
export async function resolveWorkerMcpCommand(
  command: string,
  cwd: string,
  pathValue: string,
): Promise<string> {
  const candidatePaths = path.isAbsolute(command)
    ? [command]
    : command.includes(path.sep)
      ? [path.resolve(cwd, command)]
      : pathValue.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, command));

  for (const candidate of candidatePaths) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH entries until one resolves to an executable.
    }
  }

  throw new Error(`Command "${command}" could not be resolved to an executable path`);
}
