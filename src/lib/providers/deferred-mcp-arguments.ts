type Invocation = { command: string; args: string[] };
type Server = { name: string; env?: Record<string, string> | null };

/** Compatibility entry point. Registered MCP env never exempts credential argv. */
export function bindDeferredCodexMcpLaunch(
  _env: Record<string, string>, args: string[], _servers: readonly Server[],
  build: (args: string[]) => Invocation,
): Invocation { return build(args); }
