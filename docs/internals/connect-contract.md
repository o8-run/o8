# o8 connect contract

This document is the implementation contract for one-account, multi-machine o8 connectivity. Phase 1a is the o8 client in this repository. Phase 1b adds the hosted account registry and relay protocol. Phase 2 adds the web machine switcher and remote prompt launch.

## Product boundary

- The free plan may have at most three connected machines.
- A machine is the stable o8 install identified by `getOrCreateInstallId()`, not a repository, thread, hostname, browser, or mobile pairing.
- The registry is account-scoped. A machine registered on one account must never appear in another account's list.
- Registration uses the existing o8 account and entitlement credentials. It must not introduce a separate user account or authentication flow.
- Phase 1a does not claim that the machine is remotely reachable. Registry membership and relay presence are separate states.

## Phase 1a client behavior

`o8 connect` calls the local operator-gated `/api/panel/connect` route. The route reuses the existing desktop authentication artifacts in this order:

1. The existing `x-clerk-session-token` transport, when the desktop caller supplies it.
2. The signed license token already cached by entitlement sync.

The local ws-token authenticates the CLI to the local o8 app and is never forwarded to the license server. A dispatched worker token cannot reach this panel route because it is absent from the middleware worker capability list.

If neither account credential exists, the command tells the operator to sign in through the existing desktop flow and retry. Phase 1a does not create a second CLI-only device flow.

### Sign-in without a browser

A computer with no browser (a server, a cloud box) signs in with `o8 connect --sign-in`.

1. The local route `POST /api/panel/auth/device/link` with `{ "action": "start" }` asks the account service for a one-time secret and a short code. The command prints the verification page and the code. The secret stays in the server process.
2. A signed-in person opens the page on any device, enters the code, checks the computer's name and platform, and approves.
3. The command polls the same route with `{ "action": "poll" }`. After approval the route stores the device session, renews it for a sign-in ticket, trades the ticket for an account session, syncs the account, registers the machine and turns the account link on.

The computer derives its device credential from the one-time secret, so the credential is never sent to it. The device session then renews, rotates and revokes like one enrolled by the desktop app.

After sign-in, the account link authenticates with the signed license token cached by entitlement sync. An account with no license has no cached credential, so its link stays idle until a later change gives the supervisor a renewable account session.

The machine identity sent to the registry is:

```ts
{
  installId: getOrCreateInstallId(),
  name: hostname(),
  platform: platform(),
  appVersion: packageJson.version
}
```

`o8 connect --status` lists the account's machines and identifies the current machine by matching `installId`. `o8 disconnect` looks up that same current install and deletes its registry row. Disconnect is a successful no-op when the current install is not registered.

## Hosted account-service API

The base URL is the existing `proxyBaseUrl()` value used by managed inference and entitlement sync. Every endpoint accepts:

```http
Authorization: Bearer <clerk-session-or-signed-license-token>
Accept: application/json
```

The server must resolve the bearer to one account:

- Verify a Clerk session with the same Clerk/JWKS path already used by account entitlement endpoints.
- Verify a signed license token with the existing license signing contract.
- A license whose subject is an account subject resolves directly to that account.
- An install-scoped license resolves through the existing install-to-account link created by `/account/link-install`.
- An unlinked install token must fail with `403` and `{ "reason": "account_link_required" }`; it must not create an ownerless machine record.

### Device representation

All list and conflict responses use this shape:

```json
{
  "machineId": "machine_01...",
  "installId": "stable-install-id",
  "name": "Studio Mac",
  "platform": "darwin",
  "appVersion": "0.1.631",
  "createdAt": "2026-07-29T10:00:00.000Z",
  "lastSeenAt": "2026-07-29T10:00:00.000Z"
}
```

`machineId` is the server-generated public identifier. The server never exposes its internal account key.

### Register a machine

```http
POST /machines/register
Content-Type: application/json
```

Request:

```json
{
  "installId": "stable-install-id",
  "name": "Studio Mac",
  "platform": "darwin",
  "appVersion": "0.1.631"
}
```

Success is `200`:

```json
{
  "machineId": "machine_01...",
  "deviceCap": 3,
  "devices": [
    {
      "machineId": "machine_01...",
      "installId": "stable-install-id",
      "name": "Studio Mac",
      "platform": "darwin",
      "appVersion": "0.1.631",
      "createdAt": "2026-07-29T10:00:00.000Z",
      "lastSeenAt": "2026-07-29T10:00:00.000Z"
    }
  ]
}
```

Registration is an idempotent upsert on `(accountId, installId)`. Re-registering an existing install updates its name, platform, app version, and last-seen time without consuming another device slot or changing its `machineId`.

The free-plan cap response is `409`:

```json
{
  "reason": "device_cap",
  "deviceCap": 3,
  "devices": [
    {
      "machineId": "machine_01...",
      "installId": "stable-install-id",
      "name": "Studio Mac",
      "platform": "darwin",
      "appVersion": "0.1.631",
      "createdAt": "2026-07-29T10:00:00.000Z",
      "lastSeenAt": "2026-07-29T10:00:00.000Z"
    }
  ]
}
```

Cap enforcement must be transactional. The server first checks for the existing `(accountId, installId)` row, then locks or serializes the account's active-device count before inserting a new row. Two concurrent fourth-device registrations must not both succeed.

Other responses:

- `400` for an invalid body.
- `401` for a missing, expired, or invalid bearer.
- `403` with `reason: "account_link_required"` when an install-scoped token is valid but not linked to an account.
- `404` or `501` while the registry endpoint is not deployed. Phase 1a renders both as “The o8 license server does not support machine registry yet.”

### List machines

```http
GET /machines
```

Success is `200` with a JSON array of device representations:

```json
[
  {
    "machineId": "machine_01...",
    "installId": "stable-install-id",
    "name": "Studio Mac",
    "platform": "darwin",
    "appVersion": "0.1.631",
    "createdAt": "2026-07-29T10:00:00.000Z",
    "lastSeenAt": "2026-07-29T10:00:00.000Z"
  }
]
```

An account with no registered machines receives `200` and `[]`.

### Disconnect a machine

```http
DELETE /machines/:machineId
```

Success is `204` with no response body. The endpoint is account-scoped and idempotent: deleting an absent machine owned by the authenticated account also returns `204`. A caller can never delete a machine owned by another account.

## Phase 1b server work

The license server needs a machine table with these logical fields:

```text
machine_id       server-generated public id, primary key
account_id       authenticated owner, required
install_id       stable o8 install id, required
name             last advertised hostname/default name, required
platform         last advertised platform, required
app_version      last advertised o8 version, required
created_at       first successful registration time, required
last_seen_at     most recent authenticated registration or heartbeat, required
```

Add a unique constraint on `(account_id, install_id)` and an index supporting account-scoped list and active-count queries. All reads, updates, and deletes must include the authenticated `account_id`; knowing a `machineId` is not authorization.

The server ticket includes:

1. Implement the three endpoints and response shapes above.
2. Resolve both existing Clerk session and signed license bearers to the same account identity.
3. Enforce the free-plan cap of three transactionally, with idempotent re-registration.
4. Add authenticated last-seen heartbeats:

   ```http
   POST /machines/:machineId/heartbeat
   Authorization: Bearer <machine-scoped-relay-ticket>
   ```

   Success is `204`. The server derives the account and machine from the verified ticket, ignores client-supplied timestamps, and updates `last_seen_at` to server time.

5. Add contract tests for cross-account isolation, concurrent cap enforcement, idempotent registration, heartbeat ownership, expired credentials, and the exact `409` body.

## Relay seam

The current relay cannot establish the required machine-scoped session without server changes. The Mac connector authenticates to `/mac` with the cached plan JWT and advertises only `x-o8-routing-id`. The relay stores one Mac socket per routing ID, has no `machineId` or account-machine membership, and currently gates off-network relay behind the paid `relay.offNetwork` entitlement. Wiring the phase 1a CLI to that socket would falsely report multi-machine remote reachability.

Phase 1b must add the following relay contract:

1. The hosted account service issues a short-lived machine-scoped relay ticket for an authenticated, registered machine:

   ```http
   POST /machines/:machineId/relay-ticket
   Authorization: Bearer <clerk-session-or-signed-license-token>
   ```

   The signed ticket contains `accountId`, `machineId`, `installId`, `aud: "o8-relay"`, and an expiry. Ticket issuance checks that the machine belongs to the authenticated account.

2. The Mac relay handshake sends the relay ticket and `x-o8-machine-id`. The relay verifies the ticket signature, audience, expiry, and header/claim equality before accepting the socket.
3. The relay indexes live Mac sockets by `machineId` and account, permits simultaneous sockets for different machines on the same account, and keeps at most one live socket for a given `machineId`.
4. Existing routing-ID mobile sessions remain isolated from this new account-machine routing path. The new path must not weaken the current pairing or per-device bearer checks.
5. The relay emits authenticated heartbeats to the hosted account service's heartbeat endpoint and maintains online/offline presence for the web switcher. Client timestamps are never authoritative.
6. The free plan is explicitly authorized for the connect channel up to its three registered machines. This must be a separate entitlement decision from the existing paid mobile `relay.offNetwork` flag.
7. A web relay session may address only a `machineId` returned for its authenticated account. Both the web edge and relay enforce that ownership check.

No relay client or relay-server code is part of phase 1a because none of those invariants exist in the current protocol.

## Cut 3a full-surface web-machine transport

The account-authenticated `/web/machine/:machineId` socket is one virtual browser
session. The relay allocates one `sid` for it and sends `mux-open` to the
registered machine. The desktop opens one loopback `/ws` connection for that
`sid`, using the local operator token only on the loopback URL. After the local
socket opens, the desktop returns `mux-ready`.

The web edge uses that single session in two ways:

1. HTTP requests use the existing
   `http-req { rid, method, path, headers, bodyB64 }` control frame. Documents,
   Next.js chunks, CSS, fonts, images, and API responses all return through
   `http-res` plus ordered `http-res-part` frames. Response bodies are base64,
   split at 256 KiB of encoded data per frame, and include the decoded
   `content-length` plus the safe content, cache, range, and validator headers.
2. Every non-HTTP frame is a raw `/ws` application frame. The desktop forwards
   it unchanged to the loopback realtime socket, and returns each loopback frame
   unchanged on the web session. This mirrors the phone connector's inner
   realtime shape without sharing its routing map, device credential, E2EE
   handshake, or `/mac` code path.

The browser host exposes this session to the loaded mobile application as
`window.__O8_WEB_MACHINE_TRANSPORT__`: `fetch` maps same-origin page/API requests
to HTTP control frames, while `openWebSocket('/ws')` maps the mobile realtime
hook to raw frames on the same session. The web host owns the authenticated
account handshake; browser code never supplies an account ID.

### Local credential exclusion

A web-machine replay stamps all of these headers:

```http
x-o8-client-addr: o8-relay-forward
x-o8-relay-forward: 1
x-o8-relay-surface: web-machine
```

The packaged loopback HTTP wrapper deletes any incoming
`x-o8-relay-surface`, then restores `web-machine` only when the request came
from a loopback socket carrying the relay-forward trigger. Page rendering
requires all three canonical facts before emitting the safe
`<meta name="o8-auth-mode" content="web-machine">` marker. Such a response
must not contain the local `ws-token` meta value.

On that safe browser surface, `#tk=` is scrubbed without being read or stored,
the paired-phone localStorage credential is ignored, API fetches use the web
machine transport, and `/ws` never falls back to a direct local URL. The local
operator token exists only in the desktop's server-side HTTP Authorization
override and loopback WebSocket URL; no relay frame or remote document contains
it. As a final fail-closed boundary, the machine replay scans each decoded local
response for the exact operator token and returns
`502 local_credential_exposure_blocked` with an empty body if any page, asset,
credential-export endpoint, or reflected response contains it.
Outbound loopback realtime frames receive the same exact-value check; a match
closes that web stream with `4403 local_credential_exposure_blocked`.

Closing the web session sends `mux-close` and closes its loopback HTTP/realtime
state. Dropping the active machine socket without a replacement closes its
local streams and every attached web session with
`1012 machine_disconnected`. Ticket refresh supersedes the machine socket
in-place and reopens the existing `sid` on the replacement. Any browser
reconnect creates a new web session and repeats the server-side account
ownership check before the relay assigns a `sid`.

## Phase 2 web machine switcher

The authenticated o8 website reads `GET /machines` with the existing Clerk session and shows each registered machine with its name, platform, app version, online state, and last-seen time. The selected machine ID scopes every remote request.

### Browser session ticket

The website exchanges its existing account credential for a 10-minute
machine-specific browser ticket:

```http
POST /machines/:machineId/web-session-ticket
Authorization: Bearer <clerk-session-or-signed-license-token>
```

The hosted account service performs the same active, account-scoped machine lookup used
for machine relay-ticket issuance. A machine owned by another account or an
audit tombstone receives `404 { "error": "not_found" }`. Success is:

```json
{
  "ticket": "<Ed25519 JWT>",
  "expiresAt": "2026-07-29T16:10:00.000Z"
}
```

The existing license signing key signs the JWT with issuer `o8-license`,
audience `o8-relay-web`, and claims `accountId`, `machineId`, `iat`, and `exp`.
It contains no Clerk credential, local operator token, install ID, repository,
or prompt content.

### Relay browser bootstrap

The o8 website installs that ticket as an HttpOnly relay cookie before mounting
the machine iframe:

```http
POST https://relay.o8.run/web/session
Origin: https://o8.run
Authorization: Bearer <o8-relay-web ticket>
```

`https://www.o8.run` is also accepted. No other CORS origin is allowed. The
relay verifies the ticket and confirms that its claimed account owns the
currently attached machine socket, then returns:

```http
200 OK
Access-Control-Allow-Origin: https://o8.run
Access-Control-Allow-Credentials: true
Set-Cookie: __Host-o8-web-session=<ticket>; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Strict
Content-Type: application/json

{"machineId":"machine_01...","expiresAt":"2026-07-29T16:10:00.000Z"}
```

The website calls this endpoint with `credentials: "include"` and repeats the
license mint plus relay bootstrap before expiry. Every mint and bootstrap
rechecks current ownership. The iframe URL carries only the public machine ID;
neither the Clerk token nor the web-session ticket appears in a query parameter,
fragment, DOM-readable cookie, or iframe URL. This cookie works for the o8.run
iframe because `relay.o8.run` is same-site while remaining a distinct origin.

### Relay-terminated surface

After bootstrap, the website mounts:

```text
https://relay.o8.run/web/:machineId/surface/mobile
```

Every method under
`https://relay.o8.run/web/:machineId/surface/*` requires the HttpOnly cookie.
The relay verifies audience, signature, expiry, and ticket-machine equality,
then compares the ticket account to the live machine socket account. The suffix
after `/surface` becomes the local path in the existing cut 3a
`http-req`/`http-res-part` mux. Request bodies and response bodies retain the
existing 32 MiB ceiling and 256 KiB encoded response chunks. Content type,
content length, cache validators, cache control, language, and range headers
survive the translation.

HTML root asset URLs and CSS root URLs are scoped under the same surface prefix.
The relay injects `window.__O8_WEB_MACHINE_TRANSPORT__` into token-free HTML:
same-origin fetch/XHR calls map back through the scoped HTTP route, while
`openWebSocket('/ws')` opens:

```text
wss://relay.o8.run/web/:machineId/surface/ws
```

That browser-facing WebSocket requires the same cookie and an exact allowed
browser origin, then attaches one existing machine mux `sid`. Its frames remain
the raw cut 3a `/ws` application frames. A machine drop sends presence-down and
closes the browser socket with `1012 machine_disconnected`; HTTP streams fail
closed at the same point. The existing `/mac`, `/device/:routingId`, `/machine`,
and account-token `/web/machine/:machineId` paths are unchanged.

Surface CORS responses are emitted only for `https://o8.run` and
`https://www.o8.run`. HTML sets `frame-ancestors` to those two origins. A ticket
for machine A receives `403 machine_mismatch` when presented to machine B. The
desktop's cut 3a token-free render marker, `#tk=` scrubbing, server-side
Authorization override, response byte scan, and realtime byte scan remain the
credential boundary; the relay never receives or forwards the local ws-token.

The prompt-launch path must:

1. Select a machine owned by the signed-in account.
2. Fetch that machine's reachable repositories through the authenticated machine relay session.
3. Let the operator select a repository and submit a prompt.
4. Forward the prompt to the selected machine's existing local orchestrator API through the relay.
5. Return the existing thread/turn identity so the website can show progress without inventing a second orchestration model.

The Cut 2 desktop mux carries the existing generic `http-req` frames and
replays them through the local operator gate. Phase 3 can therefore use
`GET /api/panel/repos` for repository discovery,
`POST /api/orchestrator/spawn-prompt` for prompt submission, and
`GET /api/orchestrator/lane-events` plus
`GET /api/mobile/orchestrator/threads` for progress and thread summaries. The
machine connector replaces any web-supplied authorization with the local
operator token before replay, so these routes do not gain a second auth path.

`spawn-prompt` preserves an explicit positive safe-integer `count`, including
counts above five. An omitted count defaults to one. Null, strings, fractions,
zero, negative values, and unsafe integers return a structured `invalid_request`
400 before runtime preflight or mission creation. A request that cannot be
materialized within the server process's array, serialization, or available heap
capacity returns `resource_limit` 400 without creating a partial mission. The
allocation estimate counts escaped task text in summary, prompt, and issue body,
constraints and file-reference warnings in summary and prompt, and the
mission-level constraints. It reserves metadata/object overhead and simultaneous
creation/persistence copies. This admission check does not change the saved
operator parallel cap, storage admission, runtime readiness, or downstream
approval gates.

An offline machine stays selectable for inspection but cannot accept a prompt; the website must show the server-derived last-seen state and a clear offline result.

## Open decisions

These product or security choices are outside the approved phase 1a brief. Status as of 2026-07-29:

1. **RULED (operator, 2026-07-29): device caps are free 3 / pro 10 / team 25.** Store the cap per plan on the server; the transactional enforcement and `409` body apply identically at every tier.
2. Heartbeat cadence and offline timeout — proposed default pending phase-1b review: 60s cadence, offline after 3 missed beats (180s).
3. Disconnect semantics — proposed default pending phase-1b review: retain an audit tombstone; list and cap queries exclude tombstoned rows.
4. Relay-ticket signing key ownership and ticket lifetime — proposed default pending phase-1b review: license server owns the signing key; 10-minute ticket lifetime.
5. Auto-launching the desktop sign-in UI from the CLI — deferred; phase 1b keeps the phase 1a behavior (operator uses the existing sign-in surface). A computer with no browser uses `o8 connect --sign-in` (see Sign-in without a browser).
