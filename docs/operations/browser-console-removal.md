# Browser console removal

Tracking: #6163, part of #6130. The desktop app's window is the native GPUI
window (`native/o8-next`). The browser console (the web dashboard, the mobile
web page and the canvas preview) is no longer a product surface. This note
records what each page served, what was removed, and what still needs the web
build.

## Pages

| Page | Shown by before removal | Now |
| --- | --- | --- |
| `/` | Browsers; redirected to `/dashboard` | Static notice |
| `/dashboard` | Browsers, the relay's remote browser session, the Windows and Linux classic window (loader in `scripts/tauri-export.mjs`, development URL in `src-tauri/tauri.conf.json`, prewarm in `src-tauri/src/lib.rs`), browser benchmarks. Never the GPUI window | Static notice |
| `/mobile` | Phone browsers on the local network (the old web app) and push notification links (`/mobile?view=...`). Not the native phone app | Static notice |
| `/mobile/visualizations/[id]` | The mobile web page | Removed |
| `/preview/canvas-glass` | Dashboard canvas navigation | Removed |
| `/syntax/...` (route handlers) | Highlighting assets for the dashboard's diff and file viewers | Removed |
| `/broadcast` | `o8 broadcast` spectator URLs, opened in a browser or a stream overlay | Kept (CLI feature) |
| `/dictation-pill`, `/agent-partials`, `/point-overlay`, `/spatial-ink`, `/voice-host`, `/voice-settings`, `/managed-chat-voice` | macOS shell voice windows | Kept until native |

The notice is server-rendered under a minimal root layout, with no redirect,
sign-in, operator-token metadata, shell bootstrap or application styles. The
not-found page uses the same notice instead of dashboard navigation. Its text
reads correctly both in a browser and inside the older window. The classic
window, which loads `/dashboard` on Windows and Linux, shows the notice instead
of the dashboard; its loader and the bundled-server prewarm still get an answer,
so startup does not fail.

## What only those pages reached

The candidates come from an import graph over every TypeScript and JavaScript
file in the repository (static imports, `import()`, `require`, `vi.mock` and
`new URL(..., import.meta.url)`, resolving `@/`). Kept entry points: every
remaining `src/app` page and route, `src/middleware.ts`,
`src/instrumentation.ts`, `src/ws-server.ts`, and everything outside `src/`
(CLI, scripts, configs, integrations). A file is console-only when the removed
pages reach it and no kept entry point does.

- Removed source: the dashboard (`src/app/dashboard`), mobile page
  (`src/app/mobile`), canvas preview (`src/app/preview`), most of
  `src/components/desktop` (panels, composer, settings, onboarding, terminals,
  pull request and file viewers), `src/components/mobile`,
  `src/components/mobile-split-shell`, and console-only helpers in `src/lib`
  (slash commands, mobile client, alerts, feedback client, browser telemetry,
  highlighting). Tests that only covered that UI were removed with it.
- Still shared with kept code, so kept: desktop components imported by the
  voice pages (`voice-host` reaches the chat live host and its composer queue),
  by `/api/voice/narration`, and by the native parity scripts in
  `scripts/next` (sidebar, transcript and pull request oracles that native
  tests run).
- Kept although only tests use them: about 50 pure helper modules (turn
  option resolution, transcript serializers, composer mode storage and
  similar) that kept backend tests import, plus `useBackendSwitchChoice` and
  `BackendSwitchChoice`, which a model-attribution test drives. They are not in
  any page bundle, so they do not affect build time or app size. Also kept:
  `src/components/desktop/shell/shell-geometry.ts` (a native theme test reads
  it with `include_str!`) and `src/lib/util/webview-safe.ts` (named by the lint
  guard).
- npm dependencies used only by removed code are listed in the dependency
  commit of the removal pull request.

## Phone app

The native phone app is not in this repository. The pairing route
(`src/app/api/panel/mobile-pairing/route.ts`) states that the app loads nothing
from the desktop: the QR code carries the host, ports and token, and the app
calls `/api/mobile/*` and the WebSocket server. No page URL is part of pairing.
Push payloads retain their event metadata and delivery behavior but no longer
include links to the removed mobile web page, including the push-test API.
The chat API's daily-limit response also omits its old dashboard upgrade link
and points users to desktop Settings. All mobile API endpoints and the
WebSocket server remain available.

## Relay

Two relay paths share the same tunnel protocol
(`src/lib/mobile/relay-connector-protocol.ts`, `relay-http-replay.ts`):

- Phone relay (`src/lib/mobile/relay-connector.ts`): the desktop dials out to
  the relay and replays the phone app's HTTP requests to the local API and its
  realtime frames to the WebSocket server. The native phone app uses it off the
  local network. It stays.
- Machine attach (`src/lib/connect/machine-attach.ts`, its supervisor,
  `machine-registry.ts`, `attach-settings.ts`, `open-surface-websocket.ts`):
  replays remote HTTP and WebSocket traffic for a browser on another device.
  The web-machine surface marks those page loads
  (`src/lib/connect/web-machine-surface.ts`; read in `src/components/shell-layout.tsx`,
  `ApiBearerBootstrap`, the theme pre-paint stamp and
  `src/lib/mobile/ws-token-client.ts`). The same transport carries plugin
  relay grants (`src/lib/connect/plugin-relay.ts`).

With the pages gone, a remote browser session reaches only the notice and the
voice pages. Removing the browser-session part of machine attach, and the
web-machine handling in the layout and auth helpers, touches relay, auth and
credential code. It needs its own security-reviewed pull request; this change
leaves it untouched.

## Console leftovers

The retained shell webviews and `/broadcast` opt into `shell-layout.tsx` through
their own layouts. This keeps their theme, port, navigation and credential
bootstrap while `/`, `/dashboard`, `/mobile` and missing pages use only the
minimal root layout. The mobile asset-cache reset script and mobile web-app
metadata are removed.

The orphaned public terminal stylesheet, preview image and video, asset-cache
and push service workers, and mobile web manifest are removed. The unused
editor cache group is removed from the build configuration. The unused npm
autostart wrapper is removed; desktop launch-at-login still uses the native
plugin and native bridge commands. Shared runtime and desktop dependencies stay.
Test-only helpers and native parity fixtures described above remain outside the
page bundles. The legacy mobile mode in `ApiBearerBootstrap` is retained with
the shared relay and credential helpers pending their separate review.

## What still needs the web build

The production build (`next build --webpack`, run by `scripts/build.mjs` and
the release prebuild) still compiles the API routes (the GPUI window, the CLI,
MCP and the phone app call them), the seven voice pages and their shared
components, `/broadcast`, and the notice pages. Measurements are in the
removal pull request.

## Follow-ups

- Browser benchmarks that drive `/dashboard` now measure the notice:
  `scripts/bench/run-interactions.mjs` and `scripts/bench/interactions/*`,
  `run-speed.mjs`, `dashboard-startup.mjs`, `transcript-reading-position.mjs`,
  `standalone-memory.mjs`, `run-terminal-workload.mjs`, `measure-browser-boot.mjs`,
  `prepare-launch-stage-build.mjs` (used by the manual
  `current-app-launch-stages` workflow), `scripts/measure-render-speed.sh`,
  `scripts/speed/ui.mjs`, and the opt-in
  `scripts/preship-webview-gate.mjs`. Remove or retarget them separately.
- `scripts/next/speed-receipt.mjs` compares the native window with the
  browser chat view, whose components are removed, so its browser side no
  longer builds. It stays because changing `scripts/next` needs the native
  surface label; its test is removed.
- The native parity captures (`scripts/parity`) now skip the web side unless
  `--webHost` is given. The diagnostics demo (`/api/panel/diagnostics/run-demo`)
  reports every step skipped until it targets the native window.
- The relay browser-session path above (security review).
- The test-only helpers listed above can move next to their tests or go.
