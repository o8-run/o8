*An AgentRuntime is o8's universal interface for a CLI-based coding agent. The control plane talks to this contract instead of branching on a vendor.*

# Runtime Adapter Contract

This page is for anyone who wants o8 to dispatch work to a coding-agent CLI it
does not support yet. Pick the shape that matches your CLI below, copy the
example, and open a pull request. If you are not sure which shape fits, open a
focused issue with a link to the CLI's docs and describe its launch and resume
protocol.

The adapter contract feeds the product-facing `RuntimeSurface` / `TerminalSession`
model used for launch, discovery, transcript reads, resume, interrupt, review, and
telemetry. Capabilities must stay truthful: a one-shot CLI advertises no resume,
while an interactive protocol that needs permission responses belongs on the
specialized path.

## Straightforward CLIs: one catalog entry

For a CLI with argument-based launch or resume and line, JSONL, or NDJSON output,
add one entry to `ORCHESTRATOR_RUNTIMES` in
`src/lib/orchestrator/runtime-capabilities.ts`. The runtime ID is inferred from
that object, so do not add a second union or validator list.

```ts
example: {
  label: 'Example',
  shortLabel: 'Example',
  dispatchable: true,
  requiresModel: false,
  accentColor: '#2563eb',
  binaryName: 'example',
  workerProvider: 'example',
  authHouse: 'example',
  reasoningEffort: false,
  tier: 'standard',
  description: 'Example CLI worker via JSONL output.',
  declarative: {
    launchArgs: ['run', '--json', '{{prompt}}'],
    resumeArgs: ['resume', '{{threadId}}', '{{prompt}}'],
    parserProfile: 'text',
    costFormat: 'text',
    authEnvVars: ['EXAMPLE_API_KEY'],
    authPaths: ['.config/example/auth.json'],
    authFix: 'Install Example, then run `example login`.',
  },
},
```

Templates support `{{cwd}}`, `{{prompt}}`, `{{model}}`, `{{effort}}`, and
`{{threadId}}`. A null `resumeArgs` value deliberately makes the runtime
one-shot. The current parser profiles are `text`, `openhands-ndjson`, and
`qwen-stream-json`; add a reusable parser profile when a new event dialect is
needed rather than writing a vendor-specific store.

That one entry generates or feeds:

- the `OrchestratorRuntime` type and runtime-ID guards;
- dispatch validation in API, MCP, preferences, persistence, and routing;
- desktop runtime options and operator defaults;
- database enum typing;
- auth inventory and setup guidance;
- the owned-session adapter, universal `AgentRuntime`, and cost parser.

The real-process smoke matrix in
`src/lib/runtimes/declarative-workers-smoke.test.ts` must cover every declarative
entry. A resumable representative must prove launch, discovered thread ID,
resume, clean child exit, and transcript normalization through the shared
adapter.

Every dispatchable runtime is also covered by
`tests/runtime-carrier-conformance.integration.test.ts`. That suite derives its
cases from `ORCHESTRATOR_RUNTIMES`, skips an absent real binary with an explicit
reason, and checks install detection, a parseable real `--version`, auth/readiness
evidence, and the dispatch adapter entry. A successful-but-empty auth listing is
indeterminate evidence; it must not be interpreted as a disconnected account
when stronger runtime evidence says the carrier can dispatch.

## Specialized runtimes

Use a hand-written adapter when a CLI has stateful process control that cannot be
expressed by argv and output patterns. Pi stays specialized because its RPC
stream has bidirectional permission responses; Codex, Claude Code, Gemini,
OpenCode, Cursor, and Grok also keep protocol-specific implementations.

A specialized runtime normally needs:

1. An owned-session adapter under `src/lib/<runtime>/owned.ts` that implements
   `OwnedRuntimeAdapter` and creates a store with `createOwnedSessionStore`.
2. An `AgentRuntime` under `src/lib/runtimes/<runtime>.ts` that declares truthful
   capabilities and delegates to the owned store.
3. A cost parser when the runtime emits usable telemetry.
4. One `ORCHESTRATOR_RUNTIMES` catalog entry without a `declarative` manifest.
5. Registration in `src/lib/runtimes/index.ts`.

Runtime-specific switches are acceptable only when behavior actually diverges,
such as a resume protocol or session-key format. Labels, colors, picker options,
auth houses, validation, and runtime membership come from the catalog.

Owned-session adapters advertise `workerMcpInjection: 'config-file'` when their
launch protocol accepts a per-run MCP config file, or `'config-override'` when
launch and resume accept equivalent command-line configuration overrides. The
shared controller derives both shapes exclusively from opted-in operator records.
Config files live inside the run's o8-owned session directory and reach the
adapter through `workerMcpConfigPath`; override adapters receive resolved servers
through `workerMcpServers` on every launch and resume. The packet prompt names
attached servers only for runtimes whose current adapter advertises one of these
capabilities. Adapters that omit the capability keep their existing behavior.

### Attaching operator MCP servers to your runtime's workers

[#1750](https://github.com/o8-run/o8/issues/1750) lets an operator opt each
stdio server into worker attachment from Settings → MCP with **Attach to
supported workers**. The shared controller reads only those opted-in
operator-owned records; packets and missions cannot contribute server records or
configuration.

Choose `workerMcpInjection: 'config-file'` when the CLI accepts a per-run MCP
config path. The shipped file-based adapter adds `--mcp-config <path>` and the
controller writes that file inside the o8-owned session directory. Choose
`'config-override'` when the CLI accepts per-invocation configuration overrides.
The shipped override adapter turns each server into
`-c mcp_servers.<name>.command=<TOML>`, `.args=<TOML>`, and `.env=<TOML>` flags
on launch and resume. If the CLI resumes sessions, repeat the attachment in
`resumeArgs`; otherwise its tools vanish on the first steer.

### Registering the attachment and proving it

Set `workerMcpInjection` on the owned-session adapter. A file adapter consumes
`workerMcpConfigPath` in `launchArgs`; an override adapter consumes
`workerMcpServers` in `launchArgs` and, when supported, `resumeArgs`. Add the
runtime ID to `WORKER_MCP_INJECTION_SUPPORTED_RUNTIMES` in
`src/lib/mcp/worker-injection.ts`. That gate decides whether the packet prompt
says servers are attached, so it must match the adapter. The drift assertion in
`tests/worker-mcp-injection-codex-real-path.test.ts` fails when they disagree;
extend its adapter list with the new adapter.

The shared path supplies the `{{packetId}}`, `{{worktreePath}}`, `{{branch}}`, and
`{{laneId}}` environment templating tokens, server-name validation with
`^[A-Za-z0-9_-]+$`, sandbox command resolution and read-only admission, and the
`mcp_injected` and `mcp_injection_skipped` lane events.

In the pull request, add a real-path test modeled on the two existing shapes.
Drive `buildPacketPrompt` and `launch_session` through the real lane command with
spawn mocked, then assert the emitted argv or config file and the lane events.
Also run the real CLI with the exact shape the worker receives and show that it
loads and can use a server. The override adapter was checked with
`codex mcp list --json -c …` and one `codex exec` turn carrying the worker's exact
flags. A green unit test of the argument builder is not enough.

### OpenCode: standalone workers, resident service for the operator only

`src/lib/opencode/owned.ts` passes `--standalone` on both `launchArgs` and
`resumeArgs`. Dispatched workers each run as a fully self-contained process —
no shared resident `opencode2 service` holds or caches the packet worktree, so
a worker's launch and every resume turn spawn and exit independently of that
service. The resident service (started separately, outside the owned-session
store) exists only for the operator's own interactive OpenCode use; the
location-cache release path in `src/lib/opencode/service-lifecycle.ts` is
reachable solely from packet-close cleanup
(`src/lib/orchestrator/runtime-worktree-cleanup.ts`), never from launch or
resume. The consequence: standalone workers share no session state with the
resident service or with each other — each resume rehydrates strictly from the
persisted thread id parsed out of that run's own JSONL log, not from anything
the service cached in memory.

## Current runtime set

The runtime catalog is authoritative for dispatch availability. The Google account
CLI uses the [documented headless protocol](https://antigravity.google/docs/cli/headless/) with `init`, `step_update`, and `result` event protocol with
explicit conversation IDs for resume. Its existing permissions and credit settings
remain in force; headless tools requiring approval may be denied. A result with
denied actions is reported as failed even when the CLI exits successfully. Token
telemetry does not establish a monetary charge or remaining account quota.

- Specialized: `codex`, `claude-code`, `gemini`, `opencode`, `pi`, `pi-builtin`, `cursor`, `grok`, `prime-agent`, `deepseek-harness`, and `hermes`. `pi-builtin` is the Pi SDK bundled with o8 on the managed model route; see [the Pi SDK notes](./pi-sdk-prototype.md#worker).
- Declarative: `openhands`, `goose`, `qwen`, `qoder`, `kimi`, `aider`, `3code`, `copilot-cli`, `crush`, and `antigravity`.

## Contract locations

- `src/lib/runtimes/types.ts` — universal `AgentRuntime` interface.
- `src/lib/fleet/types.ts` — product-facing runtime surface.
- `src/lib/orchestrator/runtime-capabilities.ts` — canonical runtime catalog and inferred runtime type.
- `src/lib/runtimes/declarative-workers.ts` — generated declarative registrations.
- `src/lib/runtimes/shared/owned-session` — shared owned-process lifecycle.
- `src/lib/runtimes/index.ts` — specialized runtime registration.

## Evidence ownership

Runtime, provider, model, and billing mode are separate fields. A runtime can expose several providers, one model can be reached through several runtimes, and subscription capacity is never converted into an API-token price. Unknown and stale evidence remain visible. Every catalog entry must retain at least one source, observation date, and freshness bound; `runtime-evidence.test.ts` rejects omissions before they can become silent guesses.

### Codex reasoning-effort evidence

The shared Codex effort contract lives in `src/lib/codex/reasoning-effort.ts`. Its high-end catalog records exact verified model/effort pairs from `~/.codex/models_cache.json`, client version 0.154.0, fetched 2026-09-20T02:59:18Z. That catalog receipt is distinct from the installed CLI binary receipt, 0.153.4 observed on 2026-09-19. Both the mission route and client picker consume the serializable contract. It is not a provider-name rule or a live capability query: unknown models, inherited object keys, and unlisted pairs remain unverified, so `max` and `ultra` are rejected at mission admission rather than silently changed at launch. Refresh the catalog only with a new model-catalog receipt and add fresh-launch plus persisted-resume argv proof for each pair.

## Design rules

1. The UI consumes normalized runtime surfaces, not vendor protocols.
2. Capability flags describe behavior that works today.
3. Cost and lifecycle telemetry survive normalization.
4. Missing resume support is reported honestly instead of simulated.
5. A new straightforward CLI must not require scattered runtime-ID edits.
6. A stateful newline JSON-RPC harness reuses `StdioJsonRpcPeer`; its adapter owns only protocol meaning and durable domain truth.
