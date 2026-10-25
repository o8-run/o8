import { configuredMcpEnvironment } from '@/lib/providers/spawn-environment';
import { captureMcpExecutable, type McpExecutable } from '@/lib/providers/mcp-executable';

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
  executable?: McpExecutable;
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

function templateServer(
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
    env: configuredMcpEnvironment(server.command, env ?? {}, false, server.args),
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
      .map((server) => templateServer(server, context));
    const validServers: ResolvedWorkerMcpServer[] = [];
    const skipped: WorkerMcpInjectionResolution['skipped'] = [];
    for (const server of configuredServers) {
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
        const executable = captureMcpExecutable(server.command, context.worktreePath, options.pathValue ?? process.env.PATH ?? '');
        servers.push({ ...server, command: executable.alias, executable });
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

/** Resolve its location without replacing the configured CLI name with a
 * symlink target such as cli.js. Payer identity belongs to that configured name.
 */
export async function resolveWorkerMcpCommand(
  command: string,
  cwd: string,
  pathValue: string,
): Promise<string> {
  return captureMcpExecutable(command, cwd, pathValue).alias;
}
