# Standalone broadcast page

The Next shutdown requires a spectator page that does not depend on the Next
listener. `serveBroadcastPage` in `src/lib/ws-server/broadcast-page.ts` serves
`/broadcast` (also `/broadcast/`) and its fingerprinted JS/CSS assets.
It owns no API routes or state. The HTML uses `no-store`; fingerprinted assets
are immutable. GET and HEAD return identical headers; other methods return 405.

## Mount required

This change exports the handler without mounting it because #6433 owns the WS
front-door path. That owner, or a follow-up, must import it in `src/ws-server.ts`:

```ts
import { serveBroadcastPage } from './lib/ws-server/broadcast-page';
```

Insert this one-line call in the HTTP callback before native HTTP dispatch and
Next fallback, preserving the listener's existing startup and boundary checks:

```ts
if (serveBroadcastPage(req, res)) return;
```

Until that call is added, the WS production listener does not serve this page.
The broadcast snapshot/events and orchestrator truth handlers must also be
available on that listener; their registration belongs to the API port owners.
The CLI URL builder remains `cli/src/commands/broadcast.ts` (`broadcastUrl`),
which places the credential in `url.hash`.

## Source and assets

The existing page, stage and truth components live in `src/components/broadcast`.
The Next files remain as compatibility wrappers. The component implementations
are unchanged, so fragment bootstrap and hashchange recovery, storage fallback,
Authorization headers, redacted field selection, polling and visibility behavior,
truth queries, compact/wide layouts, theme and motion remain shared.

Generate checked-in assets with Node 22 and installed dependencies:

```sh
node scripts/build-broadcast-page.mjs
node scripts/build-broadcast-page.mjs --check
```

The script uses the existing esbuild dependency. It rejects Next or `src/app`
inputs, embeds production React and framer-motion, and needs no Next build.
The JSON import lets the WS bundler embed assets without runtime filesystem paths.
Regenerate after changes to shared components or their dependencies. The small
stylesheet supplies system fonts, the body margin reset and hidden scrollbars;
operator application globals/providers are omitted. No animation is simplified.
There are no inline scripts or external asset hosts. React/motion inline styles
remain permitted; the CSP restricts scripts and API connections to the same origin
and preserves Next's same-origin frame-ancestor restriction.

## Focused verification

`tests/broadcast-static-real-path.test.ts` starts a Node HTTP server with the
exported handler and no Next process, requests the document and assets, checks
HEAD/method refusal and cache/security headers, then executes the served production
JS in jsdom. It checks fragment retention, bearer headers, token rotation, snapshot
and live event rendering, payload omission and a truth query refusal. Served
requests, rendered HTML and captured console messages contain no fixture tokens.
The existing page tests cover the shared component's remaining states.
This is handler/bundle proof; production WS mounting and a graphical browser
acceptance run remain separate verification steps.
