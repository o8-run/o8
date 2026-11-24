---
name: o8-code
description: Inspect or change application code, API behavior, routing, model calls, persistence, or architecture contracts.
---

# Code and architecture

- o8 is a Next.js 16 and React 19 app in a Tauri v2 shell. Desktop and mobile are separate surfaces.
  Orchestrator backends in `src/lib/lane/orchestrator-backends/` and worker adapters in
  `src/lib/runtimes/` are separate systems. Inspect the current registries before changing routing.

- Runtime code is the source of truth for ports, routes, commands, and registrations. Never hardcode
  API or WebSocket ports, user home paths, or stale inventory counts. Use the existing resolvers and
  registries.

- API middleware is default-deny for `/api/*`. Public routes require deliberate narrow allowlisting;
  externally reachable self-authenticating routes must verify their own credentials. Return structured
  route errors rather than throwing to the framework.

- TypeScript is strict. Use the existing two-space, single-quote, semicolon style and `@/` imports.
  The default file ceiling is 800 lines; existing waivers do not authorize new ones.

- Ad-hoc model calls use the existing proxy and routing layer. Strict-mode MCP schemas keep a plain
  top-level object; validate conditional relationships in the handler.

- Architecture and extension contracts: [`docs/internals/system-architecture.md`](../../../docs/internals/system-architecture.md),
  [`docs/internals/runtime-adapter-contract.md`](../../../docs/internals/runtime-adapter-contract.md), and the
  implementation named above. Historical inventories in docs are orientation, not runtime truth.
