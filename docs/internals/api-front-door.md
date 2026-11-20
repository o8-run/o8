# Packaged API front door

The launcher can enable the public API front door with
`O8_API_FRONT_DOOR=1`. The server does not infer this from `NODE_ENV`.
The launcher enables it by default only for development app builds; release
builds retain the existing listener arrangement until explicitly approved.
`scripts/dev.mjs` and the Next development listener are unchanged.

## Launcher contract

Start WS before Next. Supply the same explicit front-door flag, public
`O8_API_PORT`, profile/data directory and credentials to both processes.
WS advertises that port for HTTP and WebSocket connections, including when a
stale WS port file still names another listening process. Set `NEXT_ORIGIN`
to a distinct private HTTP loopback origin and bind Next there using its own
`PORT`. The upstream must have no credentials, path, query or fragment.
A missing, nonlocal or self-referential upstream refuses startup. An occupied
public API port fails takeover without evicting the existing listener.
The launcher owns port-file publication and build-mode defaults. It also gives
WS `O8_NEXT_BIN` and `O8_CODEBASE_MEMORY_BIN`: native-window launch via
POST `/api/panel/operator-defaults` is a WS route (launcher PR #6444).

In the standalone launcher, front-door mode starts and supervises o8d directly
on the public port before starting the Node WS producer. The launcher creates
one ephemeral bridge key for its lifetime; the producer attaches over the
profile's owner-only Unix socket, announcing its private loopback upstream and
realtime epoch. It never spawns o8d or takes over the public listener in this
mode. The launcher's existing ownership receipts, recovery and bounded shutdown
also cover o8d. Classic mode and older launchers retain the existing Node-owned
`O8_WS_O8D` behavior.

Without a producer, independent native operator routes keep answering. Requests
that need Node return 503 with Retry-After; `/ws` accepts no application session
or checkpoint and closes with 1013. Attachment changes close existing WS streams
for a fresh checkpoint. The actual window transport reconnects without `since`.
Node still authenticates every producer-backed WS upgrade and owns checkpoints,
commands, runtime state, and the GUI window's parent-pipe lifetime. This step
neither adds standalone native WS subscriptions nor native commit publication.
Native-reader opt-outs remain independent; session reads are not enabled globally.
`O8_NEXT_O8D` is unnecessary for registered dispatch when takeover is enabled.

## Dispatch and ownership

Registered path and method pairs execute their existing handlers and gates.
More-specific unregistered static Next routes win over a dynamic registry
match. All other methods and paths stream to private Next with the original
public Host, target, method and body. Responses retain status, redirects,
repeated cookies and streaming; disconnects cancel the upstream request.
`/ws` retains the existing authenticated WS handshake. Other upgrades go to
Next, including unsuccessful upgrade responses. An unavailable Next returns
502 for fallback requests; registered handlers remain available.

This change adds no handler registrations, databases, watchers or cache owners.
Existing owner wrappers use the same transport predicate. Any future handler
registration needs an audit through its imports and callees: when state remains
owned by Next, the route moves with its owner and stays on fallback. Sharing a
module path between processes does not establish shared state.

## Request boundary

The same Host, request-target and browser-write rules run at the front door.
Registered handlers retain middleware and principal checks. Fallback strips
hop-by-hop headers and caller-supplied private bridge/peer stamps, then derives
the peer from the socket or the authenticated o8d hop. Remote and restrictive
relay callers carry a restrictive marker across the private loopback hop.
The generated packaged Next wrapper validates the public Host against
`O8_API_PORT` while its socket remains bound to private `PORT`. Existing
internal calls may also address private `PORT` from an actual loopback socket;
peer headers cannot enable that exception, and restrictive relay stamps and
bearer checks still apply. Bearer grants are unchanged.

## Pages and review

GET and HEAD at `/`, `/mobile` and `/dashboard` serve one static desktop-app
notice. The phone preview links remain usable. `/broadcast#token=...` remains
served by `serveBroadcastPage` with fingerprinted bundled JS/CSS, independently
of Next; its fragment is client-only. Its data handlers still need registration
with their existing spectator gates. This change does not claim that Next can be stopped for
unregistered routes or pages.

Master review is required before this takeover is armed. It changes the
advertised listener, not response schemas or authorization policy. The focused
proof covers Node and o8d listeners, registered reads without Next, fallback
protocols and the generated packaged wrapper. Installed-build and launcher
release enablement remain separate evidence.
