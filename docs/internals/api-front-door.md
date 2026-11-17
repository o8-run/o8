# Packaged API front door

The launcher can give the WS process the advertised API listener with
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
The launcher owns port-file publication and build-mode defaults.

The existing `O8_WS_O8D` switch and bundled `O8D_BINARY` resolution remain in
force. When enabled, o8d owns the public listener and forwards to the private
WS listener; otherwise Node owns it. Native-reader opt-outs remain independent.
`O8_NEXT_O8D` is unnecessary for registered dispatch when takeover is enabled.
The shared transport predicate also keeps the existing owner forwarding
wrappers active with that legacy flag off.

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
available through transitional Next forwarding; its fragment is client-only.
Before Next retirement, its HTML and JS must be built to static assets and
served here, and its data handlers must be registered with their existing
spectator gates. This change does not claim that Next can be stopped for
unregistered routes or pages.

Master review is required before this takeover is armed. It changes the
advertised listener, not response schemas or authorization policy. The focused
proof covers Node and o8d listeners, registered reads without Next, fallback
protocols and the generated packaged wrapper. Installed-build and launcher
release enablement remain separate evidence.
