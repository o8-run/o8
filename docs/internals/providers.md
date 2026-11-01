# o8 next Settings › Providers (slice 1)

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

## Add provider (ACP)

"+" next to the heading opens `providers_add.rs`. The dialog has these parts:
- A grid of built-in runtimes. Clicking a tile opens that runtime's detail.
- "Or choose from ACP Registry", with search, from `GET /api/runtime/acp-registry`.
- The Add button calls `POST …/acp-registry/prepare` and then
  `POST /api/runtime/acp-connection`. Registry entries with no npm package only
  show "Setup guide only".
- "Configure manually" opens a name, executable and arguments form, which saves
  through the same `acp-connection` path.

No new endpoints. o8 has **one Local ACP slot** (`~/.o8/local-acp.json`), so adding
an agent replaces the current one, and the dialog says so. Saving also clears
`~/.o8/acp-models/acp.json`. The env editor has not been ported; the form points
to classic Settings for it. `scripts/next/surfaces/01-providers.surface.ts` serves
a synthetic registry and prepare for `--settings` fixtures.

## Surface boundary

New code lives under `src/surfaces/`, which is owned by the surface. Shared Settings
changed in three places, about 5 lines (`settings.rs`, `settings_fields.rs`,
`settings_view.rs`). The `o8 next surface boundary` check allows only one
`register_surfaces!` line outside surface modules, so a PR with these lines needs
the `shell-work` label, the same as #5224's Settings work.

## Next slices

1. Multiple ACP instances (more than the single Local ACP slot), plus per-instance
   binary and home overrides.
2. Env editor for ACP connections in o8 next.
3. Hide disabled runtimes even when they are the current or default lead, which
   needs a lead fallback.
