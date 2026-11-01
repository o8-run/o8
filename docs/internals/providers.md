# o8 next Settings › Providers

o8 next's Settings has a **Providers** section shaped like T3 Code's providers
page. It shows one row per runtime o8 can dispatch to, with a read-only detail
panel and a placeholder **+** button. The code lives in the settings surface module,
`native/o8-next/src/surfaces/settings/providers.rs`, with its tests beside it.
Shared Settings only hosts the view: one `providers: Option<AnyView>` field, one
`SECTIONS` entry and one render branch.

## What a row shows

| Part | Source |
| --- | --- |
| Name, runtime id, list order | `dispatchableRuntimes` from `GET /api/panel/operator-defaults`, the classic runtime registry (`listDispatchableRuntimes()` via `getDispatchableRuntimeAvailability`) |
| Status | Same entry. It reads `Disabled` if switched off, `Authenticated · <connection.providers>` when available with evidence, and `Available` when available with no named source. Otherwise it reads `Installed · sign-in needed`, `Installed · restart needed`, `Installed · check setup` or `Not installed` |
| Version | `tools[].version` from `GET /api/setup/detect`, normalised to `vX.Y.Z` |
| Icon | A fixed mark per runtime id (OpenAI, Anthropic, OpenCode, Pi, Grok, Cursor, Gemini, or a terminal mark otherwise) |
| Switch | `values.disabledRuntimes` from `GET /api/panel/operator-defaults?include=native` |

The detail panel shows the display name, the runtime id, the binary path
(`tools[].path` from detect, or "Not found on PATH"), and the home-directory
selector with its tilde default (for example `CLAUDE_CONFIG_DIR (default ~/.claude)`),
mirroring `src/lib/providers/runtime-profile-paths.ts`. It never resolves a real
home directory. All of it is read-only.

If detect fails or times out, only versions and paths are hidden. The list still
loads.

## The switch: `disabledRuntimes`

Classic had no setting that enabled or hid a runtime. `workerRuntimes` is the
worker pool, and `experimentalOpencode`/`experimentalGemini` cover only two runtimes.
So slice 1 adds one declared operator default:

- `OperatorDefaults.disabledRuntimes: OrchestratorRuntime[]`, default `[]` (all on).
- settings.toml: `[providers] disabled_runtimes = ["cursor", "grok"]`.
- Written by `POST /api/panel/operator-defaults?include=native` with
  `{ disabledRuntimes, settingsTomlRevision }`. That is the same revision-checked
  path every other o8 next Settings switch uses. Unknown runtime names return 4xx.
- Like Q's Settings switches, the switch moves only after the server read-back,
  and it is a fixed 34×20 track, so a save never shifts the row.

**Enforcement (slice 2).**
- Server: `src/lib/providers/disabled-runtimes.ts` checks `disabledRuntimes`
  (where `claude` means `claude-code`). `handleOrchestratorSendMsgAdmitted` in
  `ws-server.ts` refuses a turn on a disabled runtime only when the thread has
  no persisted messages, so it is a new session. Running sessions and persistent
  lead threads keep their runtime.
- Classic picker: `useRuntimeInventory` exposes `disabled`, and `ComposerPicker`
  filters with `enabledRuntimeInventory`. The current lead group stays visible.
- o8 next picker: `composer/selector.rs` is a shared file with two small edits.
  The inventory goes through `providers::picker_inventory`, which marks entries
  `disabled`. `rail_houses` then skips them, unless the entry is the current lead.

## Detail panel: binary path

The binary path and version come from `GET /api/setup/detect`, which returns
`tools[].id/version/path`. That route takes about 9 s cold and about 2 s warm,
against a 10 s route deadline. The shared o8 next ureq agent has a 5 s timeout,
so in slice 1 the request timed out and the panel always showed "Detection
unavailable". Detection is now a separate request with a 15 s timeout, sent
after the list loads, and the panel shows "Detecting…" while it waits. Paths
under `$HOME` are shown with `~`.

## Add provider

"+" next to the heading opens `providers_add.rs`. The dialog has these parts:
- A grid of built-in runtimes. Clicking a tile creates a new **provider
  instance** of that runtime, named "new", and opens its detail panel.
- "Or choose from ACP Registry", with search, from `GET /api/runtime/acp-registry`.
  Add calls `POST …/acp-registry/prepare` and saves the prepared command as a
  new ACP instance. Entries with no npm package only show "Setup guide only".
- "Configure manually" (name, executable, arguments) also creates a new ACP
  instance.

Adds never replace classic's Local ACP slot any more, so the one-slot notice is
gone. `scripts/next/surfaces/01-providers.surface.ts` serves a synthetic registry
and prepare for `--settings` fixtures, and the production `provider-instances`
route on every fixture (the composer picker reads it).

## Provider instances (slice 3)

More than one copy of a runtime, each with its own display name, binary, home
directory and env (T3's "Codex · work").

**Data model** (`src/lib/providers/instances.ts`):
- `~/.o8/provider-instances.json` (0600):
  `{version: 1, instances: [{id, runtime, name, binaryPath?, homeDir?, enabled, acp?}], threads: {threadId: instanceId}}`.
  `runtime` is a runtime id (`codex`, `claude-code`, …) or `acp`; `acp` holds
  `{name, command, args, useOpenRouter}`. Ids are `<runtime>-<slug>`.
- Every runtime keeps an implicit **default instance** (no overrides, never
  stored, not deletable). Default threads behave exactly as before.
- Env lives in the existing ACP env store (`~/.o8/acp-environment.sqlite`) under
  `instance:<id>`: ordinary values in `configuration`, secrets AES-encrypted
  with the o8 master key in `credentials`. Reads return secrets only as
  `{secret: true, configured: true}`. Nothing goes to settings.toml. The same
  name policy as the Local ACP env editor applies (no `O8_`/`CODEX_`/`OPENAI_`…
  prefixes, no provider credential names; credential-like names must be secret).
- **Migration:** classic's Local ACP slot (`local-acp.json`) is presented as the
  instance `acp` (default, "Local ACP · <name>"). It is still read and written by
  `local-connection.ts` and its env keeps its `acpEnvironmentId(connection)` key,
  so no data moves and classic keeps working.
- Home selectors (`HOME_SELECTORS`): codex `CODEX_HOME`, claude-code
  `CLAUDE_CONFIG_DIR`, gemini `GEMINI_CLI_HOME`, hermes `HERMES_HOME`, openclaw
  `OPENCLAW_STATE_DIR`, opencode `OPENCODE_CONFIG_DIR`, pi `PI_CODING_AGENT_DIR`,
  goose `GOOSE_PATH_ROOT`, qwen `QWEN_CODE_HOME`, kimi `KIMI_HOME`, antigravity
  `ANTIGRAVITY_HOME`, copilot-cli `COPILOT_HOME`. ACP has none.

**Route** `src/app/api/runtime/provider-instances/route.ts` (panel auth):
`GET` → `{instances (with masked environment), homeSelectors, thread?}`
(`?thread=<id>` adds its binding); `POST {action}` with `create {instance}`,
`update {id, instance}`, `delete {id}` (drops env, secrets and bindings), `env
{id, environment: {revision, variables}}` (revision-checked), `bind {thread, id}`
(empty id = default instance). o8 next reads it via `client.settings_request` (15 s).

**Dispatch** (`instance-context.ts`, `instance-launch.ts`): `withOrchestrationMode`
in the backend registry wraps every `sendTurn` in
`runWithThreadProviderInstance(backend, threadId)`. That resolves the thread's
instance once (decrypting env), refuses a disabled or deleted one, and runs the
turn in an AsyncLocalStorage context. Inside it:
- `childEnvironment` merges the instance's env and home selector last, only for
  spawns whose `runtimeId` is the instance's runtime (so codex's explicit
  `CODEX_HOME` is overridden for that instance only).
- `resolveCli` returns the instance's `binaryPath` (no cache).
- `resolveLocalAcpLaunch` / `localAcpProcessLaunch` use an ACP instance's
  command and env; `assertLocalAcpEnvironmentCurrent` checks its revision.

**o8 next UI:** the list shows an "Instances" group ("Codex · work"); its detail
panel (`providers_instance.rs`) edits name, binary, home and env (rows with a
Secret/Plain toggle; saved secrets show "•••••• saved" and are kept unless
retyped), and has Delete… → "Delete instance" / "Keep". The Local ACP slot's
command stays read-only there (edited by classic); its env is editable.

**Composer picker:** enabled instances appear as extra rail houses
(`lead-house-codex@codex-work`, tooltip "Codex · work") with their runtime's
models. Picking one calls `choose_lead("codex@codex-work", model)`, which posts
the routing as before and then `bind`s the (fresh, if it had history) thread.
Classic's picker is unchanged.

## Surface boundary

New code lives under `src/surfaces/`, which is owned by the surface. Shared Settings
changed in three places, about 5 lines (`settings.rs`, `settings_fields.rs`,
`settings_view.rs`). The `o8 next surface boundary` check allows only one
`register_surfaces!` line outside surface modules, so a PR with these lines needs
the `shell-work` label, the same as #5224's Settings work.

## Next slices

1. Classic composer picker for instances; per-instance API keys (blocked today
   by the env name policy for provider credentials); warm/persistent runtime
   processes started outside a turn do not see instance context.
2. Hide disabled runtimes even when they are the current or default lead, which
   needs a lead fallback.
