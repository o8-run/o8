# o8 Operator MCP Bridge

> **Current transport (2026-07):** the running app hosts the shared operator
> tool registry once at the token-gated streamable-HTTP endpoint `/api/mcp`.
> Client configs launch the thin `operator-mcp-proxy` stdio shim; the standalone
> stdio server remains only for headless use when the app is not running.

## What it is

An MCP host that turns any compatible client into a remote control for o8. The
dashboard, mobile app, and terminal clients are peer surfaces over the same
execution and governance layer.

```
Terminal (Claude Code)  →  o8_send, o8_status, o8_approve...  →  o8 API  →  Agents
Mobile app              →  WebSocket controller               →  o8 API  →  Agents
Dashboard               →  React UI                           →  o8 API  →  Agents
```

Install and inspect client configuration from Settings → MCP.

---

## What this unlocks

**1. Building and steering from one session.** Edit your project's source in Claude Code AND control the running o8 app from the same session. "Launch a Codex agent to fix the auth bug" without switching windows. The dev loop shrinks from alt-tab to one sentence.

**2. Testing the orchestrator without the dashboard.** The MCP bridge hits the same API routes the dashboard uses. If `o8_status` returns wrong data, the dashboard is also wrong — catch bugs at the API layer.

**3. Headless CI/CD agent orchestration.** A scheduled Claude Code session (via OpenClaw heartbeat or cron) can call `o8_send` to launch nightly tasks, `o8_status` to check completion, `o8_approve` to auto-approve safe merges. No dashboard open. No human in the loop for routine work.

**4. The MCP server IS the API contract.** The shared tool registry defines
what an operator can reach from external clients. If a control-plane operation
isn't represented there or in the CLI, the API surface is incomplete.

---

## What This Unlocks for Devs in General

**1. Terminal-native governance.** Power users who live in the terminal get full agent orchestration without opening a GUI. "Ship the PR" from vim. "What happened overnight?" from their morning Claude Code session.

**2. Claude Code becomes an orchestrator.** Any developer with Claude Code can now plan, delegate, monitor, and approve multi-agent work. Claude Code reads the codebase, reasons about what to do, then calls `o8_send` to dispatch agents. The user's Claude Code IS the brain, o8 IS the hands.

**3. Composable agent workflows.** Because these are MCP tools, Claude Code can chain them. "Check status, approve anything that passed CI, reject anything that touched production configs" — Claude Code reads the approvals, makes decisions, calls approve/reject. Autonomous governance with human-set policies.

**4. Session continuity across terminal restarts.** User closes their terminal, reopens next morning, says "what happened?" Claude Code calls `o8_history` — full context of what agents did overnight. The o8 server persists everything. The terminal is ephemeral, the work isn't.

---

## What This Unlocks for Production Users

**1. Three ways in, one system.** Dashboard for visual overview. Mobile for on-the-go approvals. Claude Code for power-user terminal control. Users pick the surface that fits their moment — all three see the same state.

**2. Voice-to-agent pipeline.** Voice → Claude Code dictation → `o8_send("fix the login bug")` → agent launches → dashboard shows progress → mobile pings for approval. The entire loop from intent to shipped code, spoken aloud.

**3. Team-scale delegation without context switching.** A tech lead reviews PRs in their terminal while agents work across 5 repos. `o8_status` gives the fleet view. `o8_approve` merges the clean ones. `o8_reject` sends feedback. All from one Claude Code session.

**4. The control room follows you.** The MCP bridge means you never HAVE to open the app — you talk to your agent, your agent talks to o8, work gets done, and the governance record is there when you want to look. The dashboard is the control room; the bridge means it's never a prerequisite.

---

## Tool registry

The shared registry now covers fleet status, missions and packets, review and
merge governance, webview/canvas control, repo-spec annotations, task-pool
operations, and operator defaults. Tool definitions and handlers are registered
once in `src/lib/mcp/operator-mcp-host.ts`; both HTTP and standalone stdio
transports consume that registry.

Full-profile owned orchestrators can discover definitions through
`o8_tool_search` and call them with `o8_tool_call`. External client configurations
retain the complete catalog. See [deferred tool loading](../internals/deferred-mcp-tools.md)
for runtime boundaries, worker opt-in and the full-loading override.

## Opt-in o8d MCP endpoint

Build `crates/o8d` with the `experimental-mcp` Cargo feature. The `o8d`
executable accepts `--experimental-mcp`, `--listen` with a loopback socket
address, and `--upstream` with the running TypeScript server's loopback HTTP
origin. The existing `o8d-mcp` executable accepts the same arguments. Both
require the explicit runtime flag; default endpoint selection is unchanged.

To use the existing native readers, enable `O8D_MCP_READS=1` on the
TypeScript server and pass `--native-reads --data-dir` with the same absolute
data directory to o8d. `CORTEX_IDE_DB_PATH` selects an alternate database.
On Linux, `o8_status`, `get_mission_status`, `o8_task_list`, `o8_list_repos`,
`o8_list_projects` and `o8_lease_list` read persisted state without a
TypeScript round trip after the publisher generation is authenticated.
Fresh status, stale snapshots, unsupported state and other platforms use
the original TypeScript handler. Native readers never migrate or write state.

Legacy initialization is handled by o8d after TypeScript authenticates the
caller. Catalog responses, including catalog batches, retain the exact bytes
from the authoritative TypeScript registry and its profile filter. Every
other tool, including dispatch, writes and approvals, retains its original
request body and headers through the TypeScript handler. Modern protocol
requests also retain the TypeScript path.

`tests/o8d-mcp-parity-real-path.test.ts` starts production middleware, route
handlers and o8d against isolated fixture state. `scripts/mcp-parity.ts`
replays recorded calls against two listeners, compares catalog bytes and
compares tool results and refusals field by field. `scripts/mcp-benchmark.mjs`
measures both listeners with ten warmups and 100 alternating samples per
operation. These fixture measurements do not represent a desktop session.

## Stateless protocol requests

The operator host supports `2026-07-28` requests alongside the existing
`2024-11-05` initialization path. Modern clients may call `server/discover`
or a tool directly, without initializing a transport session. Every request
includes these fields in `params._meta`:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

HTTP requests also include `MCP-Protocol-Version: 2026-07-28`,
`Mcp-Method` matching the JSON-RPC method, and `Mcp-Name` matching the tool
name for `tools/call`. Each POST contains one request. Missing or mismatched
routing fields are refused before dispatch. Modern responses include
`resultType: "complete"` and do not issue a session ID. Catalog and discovery
responses use a private, zero-duration cache hint because profile and runtime
configuration can change. Existing operator authentication and profile limits
still apply.

`o8_task_dispatch` returns its persisted launch receipt before provisioning
finishes. Modern `mission_tail` calls return the current event batch immediately,
even when `timeoutMs` is supplied. Pass the returned `nextSince` cursor into the
next poll, including after reconnecting or restarting the MCP process. Legacy
clients retain the existing bounded long-poll behavior.

The opt-in Rust endpoint forwards requests carrying protocol metadata or routing
headers to the shared TypeScript host. Its native legacy read projections do not
implement the modern envelope; this path requires the TypeScript service.
Cortex and other separately hosted MCP servers retain their own protocol support.
See the official [versioning contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
and [HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

## Architecture Decision

The user's Claude Code and o8's internal orchestrator are **peers**, not parent-child. Both can launch agents. Both can approve merges. The internal orchestrator handles missions from the dashboard chat. The MCP bridge handles intent from the terminal. They share the same API layer.

This means o8 is not a monolithic IDE — it's a governance API with multiple frontends. The MCP bridge proves the API is complete enough to drive the entire system from a 5-tool interface.

---

*Built 2026-03-30; transport consolidated 2026-07. Current seams:
`src/lib/mcp/operator-mcp-host.ts`, `src/app/api/mcp/route.ts`,
`src/lib/mcp/operator-mcp-proxy.ts`, and
`src/app/api/setup/mcp-config/route.ts`.*
