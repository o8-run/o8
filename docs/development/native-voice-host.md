# Native window voice host

In native main-window mode, the macOS shell creates a hidden, unfocusable Tauri
`main` webview at `/voice-host`. It mounts only `RealtimeVoiceHost`,
`SymonTextBridgeHost`, `NarrationSpeakerHost`, and `ChatLiveHost`, under the
existing root layout. Classic mode keeps its existing dashboard hosts.

The host waits for this shell boot's server identity. Window-state restoration
excludes it. Desktop show/focus, file-open focus, browser layout, overlay
placement and display repair use the classic-window accessor. Navigation permits
only the original loopback origin and `/voice-host`, without query or fragment.
The root navigation bridge does not install itself in this document.

## Control protocol

`GET /api/next/voice-host` reports availability, the current binding and pending
Symon confirmations. No host, or an expired heartbeat, returns HTTP 503 with
`code: VOICE_HOST_UNAVAILABLE`. The browser host renews its 15-second lease every
five seconds while its authenticated WebSocket is connected.

`POST /api/next/voice-host` proxies to the realtime process using exactly the
existing internal bearer authorization. Next route workers own no broker state.
Requests are bounded to 64 KiB; the internal HTTP timeout is 2.5 seconds.

| Action | Fields and behavior |
| --- | --- |
| `ready` | Host supplies `hostId`; refreshes its lease. |
| `start` | Next supplies `requestId`, `binding`, fresh `nonce`, `threadId`, `repoPath`, explicit `source: byok`; optional `messages` and `busy` provide conversation context. HTTP 202 means dispatched, not connected. |
| `stop` | Same binding fields and a new `requestId`; closes voice through its existing lifecycle. |
| `context` | Updates messages and busy state for the current binding. |
| `accepted` | Same binding fields, `delegationId`, and the existing chat submission's `userMessageId`. |
| `terminal` | Requests replay for an accepted delegation. Client text cannot replace server-observed evidence; missing evidence returns 409. |
| `symon-toggle` | Reaches Symon's existing toggle. |
| `decision` | Explicit boolean `allow` and an existing `confirmationId`; invokes its existing gate-owned callback. |

Start/stop IDs are body-bound and idempotent within the bounded receipt cache.
A new provider lifetime requires a new nonce. Closing and unknown sessions do
not admit another start. Reconnection does not replay start requests or tasks.

The voice route broadcasts `voice-delegate` and `voice-host-state` frames:

```json
{"type":"ui-command","kind":"voice-delegate","payload":{"hostId":"host","action":"delegate","binding":"chat","nonce":"voice","threadId":"thread","repoPath":"/workspace","delegationId":"delegation","text":"Inspect the build."}}
```

```json
{"type":"ui-command","kind":"voice-host-state","payload":{"hostId":"host","action":"terminal","binding":"chat","nonce":"voice","threadId":"thread","repoPath":"/workspace","delegationId":"delegation","voiceTerminal":{"userMessageId":"user-message","outcome":"completed","text":"The build passed."}}}
```

`voice-host-state` also carries start, stop, acceptance, session state, captions,
interrupt requests, Symon state, confirmations, dismissals and decisions.

Next submits through its existing chat entry point. The broker matches thread,
repository and accepted user ID against actual orchestrator terminal publication,
including terminals arriving before acceptance. Only correlated terminal
receipts reach the shared chat controller's reply callback. Busy=false, partial
text and submission acknowledgments are not completion evidence. Confirmed
outcomes cannot be replaced by later uncertainty.

Stopping voice leaves submitted backend work running. Spoken task cancellation
emits an interrupt request for next's existing stop path. Transport loss stops
capture and requests closure without claiming provider-confirmed closure.
Existing personal-key receipts, unknown-closure admission and usage remain in
`/api/voice/live`; no key handling, authorization, tool dispatcher or native
confirmation gate changes are made.

## Symon and microphone ownership

Keeping label `main` preserves the existing microphone claim/release, Tauri
event capabilities and desktop/phone Symon eval contracts. Fn and browser Live
continue to refuse competing microphone ownership. Mounting the hidden host
never starts a voice session automatically.

Native and managed Symon confirmations retain their gate-owned identity and
existing decision callbacks. Next must display them visibly and send an explicit
decision. Pending confirmations are available through GET and republished after
reconnect. Unknown or expired decisions do not invoke a callback.

## Verification boundary

The route test runs actual API handlers, the WS server, command admission,
transcript persistence and authoritative terminal publication. Only provider
execution is deterministic. On baseline `53a9d3016`, the new route returns 404.
Controller tests drive frames, stale bindings and confirmation callbacks without
hardware. Rust tests drive host construction, the desktop show entry point,
restoration exclusion and navigation admission with the mock Tauri runtime.

Packaged acceptance remains pending with an operator:

- First-use hidden-host microphone permission, denial and retry under the signed
  app's existing TCC identity.
- Audible WebRTC output after a native start, and exactly one delegated task's
  correlated reply, including chat switching and stop.
- Heartbeat, provider polling, inactivity and closure timers while hidden.
- Visible native/managed Symon confirmations, explicit decisions, dismissal and
  expiration through the existing native tools.
- Fn versus Symon/chat Live microphone exclusion in both start orders.
- Invisibility during launch, restoration, activation, file-open, display changes
  and Symon navigation commands.
- Incremental process-tree memory at idle, Symon Live, chat Live and after close.

Source tests do not establish any packaged microphone, audible playback or
memory measurement.

## Original voice branch receipts (before the rail port)

- Baseline `53a9d3016`: new route test failed (three tests), including the
  expected missing-route 404. The same real-path suite passes on this branch.
- Node 22 / npm 11.21.1: hermetic `npm test` with filesystem module caching
  disabled passed 9,913 tests, with five skipped, in 536.92 seconds.
- Final focused voice run: 73 tests passed across ten files in 41.19 seconds.
  This includes a 50,000-character authoritative terminal, persisted assistant
  text, the headless 503, internal authorization, aborted POST, stale binding,
  asynchronous acceptance exclusion and both Symon startup-cancellation cases.
- Rust host guards: three passed. Existing microphone ownership: three passed.
  Existing presentation/shortcut checks: two passed.
- First `cargo build --locked`: 36.16 seconds, failed on a missing ignored
  `speech-local` sidecar resource. Existing local sidecar/server build resources
  supplied the compile prerequisites; they are not packaged acceptance proof.
- Successful production Cargo build at nice 5: 185.98 seconds.
- Fast type checking, touched-file ESLint, rule checks and diff whitespace checks
  passed. No packaged microphone, audio, hidden timer or memory receipt exists.

## Rail branch activation and transport

This port preserves the rail branch's default shell startup. Start the Tauri
shell with `O8_NEXT_MAIN_WINDOW=1` to select the hidden `main` voice host while
the existing rail launcher owns the o8 next window. This switch does not launch
o8 next or import the draft's window/updater integration. Without the switch,
the classic dashboard keeps its existing hosts and behavior.

Host publications use `POST /api/next/voice-host` with
`{action:"publish",kind:"voice-host-state"|"voice-delegate",payload:{...}}`.
The broker validates the lease and correlation before broadcasting its existing
`ui-command` frame. The generic `/api/next/ui-command` and `/internal/ui-command`
routes are not part of this port. The internal voice route reuses the unchanged
`isAuthorizedInternalRequest` check.
