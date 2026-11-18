# Phone read front-door group 1

The catalogue subset registers three GET routes in the existing HTTP registry: `/api/mobile/orchestrator/models`,
`/api/mobile/orchestrator/openclaw-agents`, and
`/api/mobile/orchestrator/openclaw-availability`. This group depends on #6433
for the advertised API listener. It adds no grants and changes no writer.

## Callers and owner state

The phone source at `cd7365c53038c6e8a24d1043ad2f620f6bf427cd` calls all three
from `src/o8/orchestrator.ts`: model catalogue with its normal auth headers,
and OpenClaw agent and availability GETs. There are no request bodies or query
selectors. The shared HTTP dispatcher retains middleware, socket-derived peer
truth and the models handler's operator/device check and worker refusal.

The models reader calls `mobileModelCatalog`, which reads operator defaults
through `getOperatorDefaultsSync` and `loadOperatorDefaultsFilesSync`, and
reads selected-account model discovery through `readCodexModelDiscovery` and
`getSelectedRuntimeIdentitySync`. These paths read the defaults files,
`runtime-identities.json` and the selected account's `models_cache.json` on
each request. They do not call the defaults/identity writers or their queues.
The model/effort tables are static. Existing Next and WS callers of these
readers can observe the same files without a database, watcher or mutable
model catalogue cache. Configuration writers retain their existing owners.

OpenClaw agent enumeration now lives in `openclaw-catalog.ts`, a file-only
reader with the same source configuration path and projection. The backend
reexports and calls this reader, and the profile builder imports its source
path. The phone route does not import the live backend, session Map, profile
builder or gateway. Availability reads the same file without opening a gateway.
The existing backend and profile lifecycle remain unchanged.

## Evidence and limits

`tests/phone-catalog-registration-real-path.test.ts` launches an isolated Node
process with the actual HTTP dispatcher and original-handler reference HTTP
listener. It compares thirty bearer/relay outcomes, including operator, paired
device, worker, wrong and absent bearer, and forged peer/bridge headers. No Next
process or packaged rehearsal is involved. Live OpenClaw configuration and Codex
account discovery replacements are visible on the following request. The child
asserts no database files, no filesystem watchers, and no loaded live OpenClaw
backend/profile/gateway modules. Before registration the first catalogue GET
returns 404; after registration this test passes.

This preserves existing catalogue payloads. The known mobile-model-catalog
expectation failure is not corrected or dismissed by registration parity.

## Connected phone read group

The same registry group also exposes the existing TypeScript GET handlers for:

| Route | Current phone caller and request |
| --- | --- |
| `/api/mobile/activity` | `src/o8/orchestrator.ts`, GET |
| `/api/mobile/automations` | `src/app/(settings)/scheduled-tasks.tsx`, GET |
| `/api/mobile/diff-comments` | `src/o8/diff-comments.ts`, `sessionKey` query |
| `/api/mobile/files/content` | `src/app/thread-files.tsx`, thread/session identity and `path` |
| `/api/mobile/files/list` | `src/app/thread-files.tsx`, thread/session identity and directory |
| `/api/mobile/orchestrator/packets` | `src/o8/orchestrator.ts` and `inbox-threads.ts`, `repoPath` query |
| `/api/mobile/usage/history` | `src/o8/use-usage-history.ts`, `range` query |

Together with the three catalogues this is ten route paths, GET only. The exact
method/path contract is checked by `tests/phone-read-group1-routing.test.ts`.
`/api/mobile/agents` and `/api/mobile/ws-token` have no actual call in the pinned
phone source and are not added. Comments and retained desktop APIs do not count
as phone calls.

These are registrations of the original TypeScript handlers, not native readers
or new state owners. The handlers keep their existing registry, lane, thread,
automation, comment and usage stores in WS. The candidate depends on the master
launcher's Next-off mode and WS startup-bootstrap follow-up to run formerly
Next-owned startup work before the connected candidate is used. The same master
integration campaign verifies that lifecycle; this group does not claim it from
registry tests. No Rust read, live-view port, default flip or writer is added.
