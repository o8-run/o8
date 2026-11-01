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

**Not yet enforced.** Slice 1 stores the preference only. Classic's
picker, the o8 next composer selector and dispatch do not read it yet. Wiring
those consumers is slice 2 work.

## Surface boundary

New code lives under `src/surfaces/`, which is owned by the surface. Shared Settings
changed in three places, about 5 lines (`settings.rs`, `settings_fields.rs`,
`settings_view.rs`). The `o8 next surface boundary` check allows only one
`register_surfaces!` line outside surface modules, so a PR with these lines needs
the `shell-work` label, the same as #5224's Settings work.

## Next slices

1. Honour `disabledRuntimes` in the composer selector, classic `ProvidersTab`, and
   `assertRuntimeDispatchable`.
2. Port `AcpRegistryPicker.tsx` behind **+**, reusing `/api/runtime/acp-registry`
   and `/prepare`.
3. Manual / Local ACP form (`/api/runtime/acp-connection`), then per-instance
   binary/home overrides.
