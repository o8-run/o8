# Native window voice host

In native main-window mode, the macOS shell creates a hidden, unfocusable Tauri
`main` webview at `/voice-host`. It mounts only `RealtimeVoiceHost`,
`SymonTextBridgeHost`, `NarrationSpeakerHost`, `ChatLiveHost`, and
`HeadlessDictationHost`, under the
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
| `accepted` | Same binding fields, `delegationId`, and the durable composer submission's `queueItemId`. |
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
{"type":"ui-command","kind":"voice-host-state","payload":{"hostId":"host","action":"terminal","binding":"chat","nonce":"voice","threadId":"thread","repoPath":"/workspace","delegationId":"delegation","voiceTerminal":{"queueItemId":"next-voice-123","outcome":"completed","text":"The build passed."}}}
```

`voice-host-state` also carries start, stop, acceptance, session state, captions,
interrupt requests, Symon state, confirmations, dismissals and decisions.

Next submits delegated text with `POST /api/orchestrator/composer-queue`,
`intent: send-next`, and an item ID of `next-<Live session nonce>-<any suffix>`. After the durable
POST succeeds, next sends `accepted` with that `queueItemId`. The broker checks
the queue item's saved thread, canonical repository, intent and nonce prefix;
a queue item cannot belong to two delegations. No socket send or synthetic
`orch-user-*` identity is required.

```json
{"action":"accepted","binding":"chat","nonce":"voice","threadId":"thoughts-chat","repoPath":"/workspace","delegationId":"delegation","queueItemId":"next-voice-123"}
```

The server polls pending accepted items every 250 ms. A held queue row yields
`outcome: held`, with its saved reason; a removed item also stays held for voice.
For an applied bound chat item, the server reads the final text and terminal
receipt of exactly `assistant-queued-<queueItemId>`. For a persistent lead it
resolves `composer-queue:<queueItemId>` to the admitted turn, then reads that
turn's authoritative terminal (including its root's continuations). Lead queue
admission can mark the queue item applied while execution is still running;
that never produces a voice completion. Only an explicit completed receipt
produces `completed`; a definite backend failure produces `failed`. Blocked,
approval-required, interrupted and unconfirmed outcomes stay `held`.

Terminal frames carry `voiceTerminal: {queueItemId, outcome, text}`. Durable
receipts also cover a terminal arriving before acceptance. Only that queue ID's
terminal reaches the shared chat controller's reply callback. Its outer frame
may also include `transcriptUserMessageId`, resolved from an actual persisted
user row, solely to link and deduplicate voice captions. A queue ID is never
stored as a transcript user ID. Busy=false, partial text and submission acknowledgments are not completion evidence.

Stopping voice leaves submitted backend work running. Spoken task cancellation
emits an interrupt request for next's existing stop path. Transport loss stops
capture and requests closure without claiming provider-confirmed closure.
Existing personal-key receipts, unknown-closure admission and usage remain in
`/api/voice/live`; no key handling, authorization, tool dispatcher or native
confirmation gate changes are made.

## Composer dictation

Only `/voice-host` mounts `HeadlessDictationHost`. It shares the native STT
invoke/event contract from `useNativeDictation`; Classic `DictationHost` and
its textarea routing and shortcuts stay unchanged. Next owns the composer,
keyboard handling and send action. Dictation and Live have separate bindings.

Both actions use `POST /api/next/voice-host`, the four binding fields, and a
fresh body-bound `requestId`. Retries of the same request are idempotent within
the bounded receipt cache. The binding nonce can be reused with a fresh start
request ID. Frames also carry that start `requestId`, so delayed publications
from an earlier recording cannot affect a retry. There is no lifetime limit on
recordings.

```json
{"action":"dictation-start","requestId":"mic-start-1","binding":"composer","nonce":"dictation-1","threadId":"thoughts-chat","repoPath":"/workspace"}
```

```json
{"action":"dictation-stop","requestId":"mic-stop-1","binding":"composer","nonce":"dictation-1","threadId":"thoughts-chat","repoPath":"/workspace","submit":true}
```

HTTP 202 means dispatched. The corresponding state frame confirms microphone
admission. Another active dictation returns HTTP 409 with `VOICE_INPUT_BUSY`.
Fn or Live ownership is checked atomically by Rust; refusal produces an error
state with the existing "Another voice input is active" message. No host still
returns prompt HTTP 503 `VOICE_HOST_UNAVAILABLE`.

The UI relay broadcasts full transcript snapshots, not append deltas:

```json
{"type":"ui-command","kind":"dictation-text","payload":{"hostId":"host","requestId":"mic-start-1","binding":"composer","nonce":"dictation-1","threadId":"thoughts-chat","repoPath":"/workspace","text":"Check the build.","final":true}}
```

```json
{"type":"ui-command","kind":"dictation-state","payload":{"hostId":"host","requestId":"mic-start-1","binding":"composer","nonce":"dictation-1","threadId":"thoughts-chat","repoPath":"/workspace","state":"listening"}}
```

`dictation-state.state` is `listening`, `idle` or `error`; an error can include
`error`. Partial text uses `final:false`. `submit:true` stops capture, waits for
the polished result and sends one `final:true` frame before idle. Next can then
submit its composer. `submit:false` cancels delivery, discarding late text. Empty
speech or a missing final result yields an error instead of a submission.

The native start opts into exclusive ownership without changing Classic's
start behavior. Native stops carry the exact STT session ID. Fn/system events
and mismatched session IDs are ignored. The native pipeline pins a headless
session's in-window origin through finalization so a subsequent Fn gesture
cannot redirect its text to system paste or consume that gesture's mode flags.
Disconnect/unmount stops the owned capture, including a late startup reply;
stale publication failures cannot stop a replacement binding. The host has no
textarea, pill, focus listener or keyboard shortcut.

Every Fn mode takes priority over composer dictation. Native admission reserves
Fn atomically, cancels the headless session and discards its pending final text.
The binding receives `dictation-state` with `state:"idle"` and
`error:"Stopped by Fn"`. Composer dictation still refuses an existing Fn or Live
owner. Native cancellation is session-fenced and remains effective during polish.
Reload/close and page disconnect cancel capture. While a headless session exists,
the shell checks the existing authenticated voice-host state once per second
with a two-second HTTP timeout. Expired host leases, retired bindings and native
terminal/error events release the claim; the page also enforces its 15-second
ready lease. These checks run only for composer dictation.

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

The route test runs actual API handlers, the WS server, durable composer
admission and settlement, transcript persistence and authoritative terminal mapping. Only provider
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
shell on macOS with `O8_NEXT_MAIN_WINDOW=1` to select the hidden `main` voice host while
the existing rail launcher owns the o8 next window. This switch does not launch
o8 next or import the draft's window/updater integration. Without the switch,
the classic dashboard keeps its existing hosts and behavior.

Host publications use `POST /api/next/voice-host` with
`{action:"publish",kind:"voice-host-state"|"voice-delegate"|"dictation-text"|"dictation-state",payload:{...}}`.
The broker validates the lease and correlation before broadcasting its existing
`ui-command` frame. The generic `/api/next/ui-command` and `/internal/ui-command`
routes are not part of this port. The internal voice route reuses the unchanged
`isAuthorizedInternalRequest` check.

## Durable queue amendment

Acceptance uses `queueItemId` rather than a socket command's user message ID.
The real server test posts queued sends through the native HTTP registry and
verifies completed, held and failed outcomes. Lead coverage drives the queue
route, heartbeat, persistent lead lifecycle and broker, including applied
admission before execution has settled. The controller also covers a terminal
received before acceptance. No confirmation gate or dispatcher changed.


Amendment verification:

- The updated route test failed on `547f3cc87` at queue acceptance (HTTP 400),
  then passed after the queue contract and mapping changed.
- Focused suite: 75 tests passed across eight files in 37.88 seconds. It covers
  completed, failed and held queue receipts; applied lead admission before its
  terminal; a later lead stop; early terminal replay; and caption persistence.
- Hermetic regression suite: 9,916 tests passed, five skipped, in 398.79 seconds.
  Fast type checking,
  touched-file ESLint, classification manifest, rule and whitespace checks passed.
- Rust and `native/o8-next` sources did not change in this amendment. The packaged
  checks listed above remain pending.

## Headless dictation verification

- At `5caf89703`, the new route-to-host test was red: dictation start returned
  HTTP 409 instead of dispatching. It passes with the adapter and protocol.
- Focused voice/dictation acceptance: 80 tests passed across eight files in
  71.34 seconds, including retrying the same binding after cancellation/busy. The new
  real-path suite drives actual API handlers, native HTTP registration, the WS
  broker and the mounted host handler. Only native hardware IPC is deterministic.
- Native microphone admission: five Rust tests passed, including production
  STT-command refusal before hardware access. Six STT tests and three hidden
  host guards passed as well: 14 Rust tests total.
- Hermetic completion gate: 9,925 passed, five skipped (1,295 passed files,
  three skipped), in 957.90 seconds. Fast type checking, touched-file lint,
  classification manifest, rule checks and whitespace checks passed.
- Packaged microphone/TCC, audible Live coexistence, physical Fn and composer
  integration checks remain pending with an operator; source fixtures do not
  establish them.
