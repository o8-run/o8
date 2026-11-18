# Phone TypeScript route group 3

This group builds on the first two phone groups. It adds eight route paths'
missing method contracts to the WS registry using their existing TypeScript
exports. There is no new writer, Rust reader or state-owner implementation.

Caller reference: o8-mobile cd7365c53038c6e8a24d1043ad2f620f6bf427cd.

| Route | Methods added | Current phone caller |
| --- | --- | --- |
| /api/mobile/action | POST | o8/orchestrator.ts |
| /api/mobile/diff-comment | POST | o8/diff-comments.ts |
| /api/mobile/enroll | POST | o8/e2ee.ts, called by pairing.ts |
| /api/mobile/live-activity/register | POST DELETE | o8/live-activity-push.ts |
| /api/mobile/live-activity/sync | POST | o8/live-activity-push.ts |
| /api/mobile/orchestrator/threads | POST, retaining GET | o8/orchestrator.ts |
| /api/mobile/ripple/resolve | POST | o8/ripple.ts |
| /api/mobile/terminal-input | POST | o8/terminal-scope.ts |

The existing bodies, mutation handling, principal checks and response contracts
are unchanged. The terminal handler still reaches the existing WS
terminal-voice-input endpoint; thread creation still uses the original canonical
thread store. Only the existing composer registration needs the thread POST
method; the shared matcher resolves methods across duplicate surface paths.

## Focused contracts

The method matrix checks all eight paths, including DELETE registration and the
retained thread GET. The real HTTP test initializes the existing WS modules and
database owner before requests. It obtains a code through the original registered
panel/mobile-pairing route, consumes it through mobile/enroll, and checks:

- The code succeeds once and reuse returns 403.
- Exactly one device row is added through the same SQLite handle.
- The stored token is a hash, the device token differs from the operator token,
  and the returned server identity matches the original pairing payload.
- A refresh with the enrolled device returns no operator token, fresh enrollment
  code or identity bootstrap.
- Existing thread and terminal POST JSON validation remains reachable.

Before registration, the enrollment POST returns 404 and the method matrix is
missing the action POST. A first fixture run timed out during cold module imports;
setup now loads the actual WS owners before timing the request test, matching
the runtime's startup-before-use contract. It does not relax the request checks.

## Caller audit and exclusions

The source audit follows imports from phone app entries and checks literal and
template API callers, rather than treating comments as calls. Existing direct
source-control actions and chat-history mutations were already registered and
are retained.

The phone still contains reachable calls to explicitly retired Symon, dictation
and TTS endpoints. Those server handlers are absent and are not restored. The
optional mobile/push/register request also has no existing server handler; the
phone explicitly treats its 404 as an unavailable seam and retries later. These
are existing caller dispositions, not newly implemented routes. Likewise, no
absent-caller mobile/agents, mobile/ws-token or server-only push-url registration
is added by these phone groups.

The coordinated Next-off candidate retains the master launcher, TypeScript-read
guard and startup-bootstrap dependencies. Required merge checks, independent
review and combined-head integration acceptance remain outside these source
registrations.
