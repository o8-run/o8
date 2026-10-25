import { configuredMcpEnvironment } from './spawn-environment';
import { parse } from 'smol-toml';

type Invocation = { command: string; args: string[] };
type Server = { name: string; command?: string; args?: string[]; env?: Record<string, string> | null };
const launches = new WeakMap<object, { actual: readonly string[]; checked: readonly string[]; grants: string[]; servers: Server[] }>();

function registeredEnvironmentArgument(arg: string, servers: readonly Server[]): boolean {
  try {
    const config = parse(arg);
    if (Object.keys(config).length !== 1 || !config.mcp_servers || typeof config.mcp_servers !== 'object' || Array.isArray(config.mcp_servers)) return false;
    const entries = Object.entries(config.mcp_servers);
    if (entries.length !== 1) return false;
    const [name, server] = entries[0];
    if (!server || typeof server !== 'object' || Array.isArray(server) || Object.keys(server).length !== 1 || !('env' in server)) return false;
    const env = server.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
    const match = servers.find(candidate => candidate.name === name);
    const registered: Record<string, string> = match?.command ? configuredMcpEnvironment(match.command, match.env ?? {}, false, match.args) : {};
    return Object.keys(env).length === Object.keys(registered).length
      && Object.entries(env).every(([key, value]) => typeof value === 'string' && registered[key] === value);
  } catch { return false; }
}

/** payer policy part b: bind operator-registered MCP env to this exact worker invocation.
 * Runtime branding or a TOML-shaped shell argument alone never grants an exception.
 * The trusted worker builder wraps both copies identically, including workspace/carrier guards.
 */
export function bindDeferredCodexMcpLaunch(
  env: Record<string, string>, args: string[], servers: readonly Server[],
  build: (args: string[]) => Invocation,
): Invocation {
  const invocation = build(args);
  const checked = args.map((arg, index) => ['-c', '--config'].includes(args[index - 1])
    && registeredEnvironmentArgument(arg, servers) ? 'mcp_servers.__deferred.env={}' : arg);
  if (checked.some((arg, index) => arg !== args[index])) {
    const checkedInvocation = build(checked);
    launches.set(env, { actual: [invocation.command, ...invocation.args], checked: [checkedInvocation.command, ...checkedInvocation.args],
      grants: args.filter((arg, index) => checked[index] !== arg),
      servers: servers.map(server => ({ ...server, args: server.args ? [...server.args] : undefined, env: server.env ? { ...server.env } : server.env })) });
  }
  return invocation;
}

export function deferredMcpArgumentsForCheck(env: object, args: readonly string[]): readonly string[] {
  const launch = launches.get(env);
  return launch && launch.actual.length === args.length && launch.actual.every((arg, index) => arg === args[index])
    && launch.grants.every(arg => registeredEnvironmentArgument(arg, launch.servers))
    ? launch.checked : args;
}
