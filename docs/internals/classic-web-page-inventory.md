# Remaining Next pages

The classic web page archive for #5243 starts at restore commit
`ed8f01ffb6506432b69b85ba6248964e49804af5`. Recover an archived file from that
commit with `git restore --source=<restore-commit> -- <path>` on a new branch.
The `src/app/api/**` endpoints remain available. Phone APIs, the WS server, the MCP
server, the CLI, and shared desktop modules remain available.

The source inventory at that commit has 32 pages (20 preview pages). This archive
removes the 19 preview pages that nothing loads and keeps 13. The browser console removal later removed `/preview/canvas-glass` and `/mobile/visualizations/[id]` and replaced `/`, `/dashboard` and `/mobile` with a static notice, leaving 11. `tests/classic-web-page-inventory.test.ts` checks
the remaining Next page entry points. Auxiliary modules under `app/preview`
can remain when retained pages import them; they do not create routes.

| Kept page | Remaining caller or purpose |
| --- | --- |
| `/` | Static notice that the desktop app is the interface. The browser console was removed (see [browser console removal](../operations/browser-console-removal.md)). |
| `/dashboard` | Static notice. The classic window's loader (`scripts/tauri-export.mjs`), the development URL and the bundled-server prewarm still request it, so it must answer. |
| `/broadcast` | `cli/src/commands/broadcast.ts` returns spectator URLs at this page. |
| `/dictation-pill` | `src-tauri/src/dock_window.rs` hosts the Symon dictation pill. |
| `/voice-host` | `src-tauri/src/voice_host.rs` hosts browser voice runtimes for the native main window. |
| `/voice-settings` | `src-tauri/src/lib.rs` opens the voice settings webview. |
| `/managed-chat-voice` | `src-tauri/src/managed_voice_window.rs` hosts managed chat voice. |
| `/point-overlay` | `src-tauri/src/point_overlay.rs` hosts the pointer overlay. |
| `/spatial-ink` | `src-tauri/src/spatial_ink_window.rs` hosts the ink overlay. |
| `/agent-partials` | `src-tauri/src/agent_partials_window.rs` hosts partial agent output. |
| `/mobile` | Static notice for old bookmarks and web installs. Push payloads no longer link here. The native phone app loads no web page. |

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

The browser console removal deleted the last Next-rendered callers of
`/api/panel/devices`, `/api/tasks/[taskId]/preview` and `/api/canvas/intent`
(`O8Panel`, `DevicePanel`, `ThreadPreview` and the canvas page). The routes stay
for the native window, the CLI and MCP; their Next-only classification can be
revisited separately.
