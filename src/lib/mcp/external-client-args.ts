/**
 * external-client forwarding serializers — the two wire shapes o8's operator
 * server is handed to the Hermes / OpenClaw MCP CLIs.
 *
 * Extracted verbatim from `app/api/setup/external-client/route.ts` (Step E2) so
 * both shapes are unit-testable WITHOUT spawning the CLIs. The route still owns
 * the spawn; this owns only the argument/payload serialization. external-client
 * forwards ONLY the operator entry (named "o8") — never DB
 * externals.
 *
 *   hermes   → `hermes mcp add o8 --command <cmd> [--args <a>...] [--env K=V]...`
 *   openclaw → `openclaw mcp set o8 '<json>'`  (json = {command, args, env})
 */

export interface ForwardedServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Build the `hermes mcp add o8 …` argv (everything after the cli path). */
export function hermesAddArgs(server: ForwardedServer): string[] {
  const args = ['mcp', 'add', 'o8', '--command', server.command];
  if (server.args.length > 0) {
    args.push('--args', ...server.args);
  }
  for (const [k, v] of Object.entries(server.env)) {
    args.push('--env', `${k}=${v}`);
  }
  return args;
}

/** Build the JSON blob for `openclaw mcp set o8 '<json>'`. */
export function openclawSetPayload(server: ForwardedServer): string {
  return JSON.stringify({
    command: server.command,
    args: server.args,
    env: server.env,
  });
}
