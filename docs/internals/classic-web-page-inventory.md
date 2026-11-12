# Remaining Next pages

The classic web page archive for #5243 starts at restore commit
`ed8f01ffb6506432b69b85ba6248964e49804af5`. Recover an archived file from that
commit with `git restore --source=<restore-commit> -- <path>` on a new branch.
All `src/app/api/**` files remain unchanged. Phone APIs, the WS server, the MCP
server, the CLI, and shared desktop modules remain available.

The source inventory at that commit has 32 pages (20 preview pages). This archive
removes the 19 preview pages that nothing loads and keeps 13. `tests/classic-web-page-inventory.test.ts` checks
the remaining Next page entry points. Auxiliary modules under `app/preview`
can remain when retained pages import them; they do not create routes.

| Kept page | Remaining caller or purpose |
| --- | --- |
| `/` | `scripts/measure-render-speed.sh` loads it; keeps the redirect to `/dashboard`. Native API-base URLs alone are not page loads. |
| `/dashboard` | `src-tauri/tauri.conf.json` development URL; `scripts/tauri-export.mjs` packaged classic-window loader; `src-tauri/src/lib.rs` bundled-server prewarm; browser boot and interaction benchmarks. `next_main.rs` still supports the classic development/fallback window. |
| `/broadcast` | `cli/src/commands/broadcast.ts` returns spectator URLs at this page. |
| `/preview/canvas-glass` | Dashboard `openCanvas` and `CompactNavigationRail` navigate here; `/api/canvas/intent` also loads it. |
| `/dictation-pill` | `src-tauri/src/dock_window.rs` hosts the Symon dictation pill. |
| `/voice-host` | `src-tauri/src/voice_host.rs` hosts browser voice runtimes for the native main window. |
| `/voice-settings` | `src-tauri/src/lib.rs` opens the voice settings webview. |
| `/managed-chat-voice` | `src-tauri/src/managed_voice_window.rs` hosts managed chat voice. |
| `/point-overlay` | `src-tauri/src/point_overlay.rs` hosts the pointer overlay. |
| `/spatial-ink` | `src-tauri/src/spatial_ink_window.rs` hosts the ink overlay. |
| `/agent-partials` | `src-tauri/src/agent_partials_window.rs` hosts partial agent output. |
| `/mobile` | Parked phone web UI; parked features stay in the app (ROADMAP, Parked). README pairs phones to it and push notifications link to `/mobile?view=...`. |
| `/mobile/visualizations/[id]` | Part of the parked phone web UI. |

Removed pages:

- `/preview/agent-card`
- `/preview/artifacts`
- `/preview/bootloader`
- `/preview/compaction-thread`
- `/preview/composer-steer`
- `/preview/effects`
- `/preview/first-run`
- `/preview/footer-image`
- `/preview/footer-scene`
- `/preview/icons`
- `/preview/motion`
- `/preview/portal-card`
- `/preview/scene-card`
- `/preview/shader-card`
- `/preview/subagents`
- `/preview/tab-strip`
- `/preview/worker-pane`
- `/preview/worker-transcript`
- `/preview/workspace-controls`

Before removal, each page path was searched in `src-tauri/src`,
`native/o8-next/src`, `scripts`, `cli/src`, `crates`, and `tests`. References to
phone APIs and source imports are distinct from page navigation. Preview-only tests
were archived with their pages. Onboarding fixtures used by retained desktop tests moved to
`tests/fixtures/onboarding`.

## Native transport follow-up

A Next-rendered page still calls **both** `/api/panel/devices` and
`/api/tasks/[taskId]/preview`: `/dashboard` renders `O8Panel`, whose device tab
mounts `DevicePanel`, and its task views mount `ThreadPreview`. Their modules and
tests stay. Registering the native transport must account for those live callers.

`/api/canvas/intent` stays in `RETIRED_WITH_REASON` in
`tests/fixtures/o8d-next-only-routes.ts` because the canvas page and its callers
still exist. Removing that entry now would hide an active Next-only caller.
