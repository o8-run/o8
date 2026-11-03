# o8d A1 read registrations

Scope: #5243 and #5422. Seventeen paths gain GET surface registrations using production handlers. No new
POST, PATCH, PUT or DELETE registration is included. Shared shell tools are
assigned to `session`; duplicate entries name additional registered callers.
The native source paths below are relative to `native/o8-next/src`.

Auth basis: **gate** means `panelGateMiddleware` requires the operator bearer
on the unverified relay. **panel** adds the handler's `requirePanelAuth`.
**visualization** adds operator or packet-worker authority and persisted packet
ownership. **public** is the existing deliberately public status GET.
No peer header grants local authority.

| GET path | Surface keys | Native caller | Auth basis |
| --- | --- | --- | --- |
| `/api/panel/branches` | session | composer/prompt_controls.rs | gate |
| `/api/panel/commits/[hash]` | diff, activity | diff.rs, opened by surfaces/activity.rs | gate |
| `/api/panel/files` | session | files_panel/tree.rs, search.rs; composer/prompt_view.rs | gate |
| `/api/panel/file-diff` | session, pull_requests | files_panel/changes.rs; surfaces/pull_requests/comparison.rs | gate |
| `/api/panel/status` | session, settings, pull_requests | client.rs; settings_diagnostics.rs; surfaces/pull_requests | public |
| `/api/panel/resource-usage` | session | shell_features/right_panel/resources.rs | gate |
| `/api/panel/serve-image` | session | files_panel/media.rs | gate |
| `/api/visualizations/[id]` | session | visualizations/mod.rs | gate + visualization |
| `/api/repo-spec` | session | files_panel/spec.rs, spec_actions.rs | gate; existing device/worker capabilities retained |
| `/api/review/workspace` | session, activity | files_panel/changes.rs; shell_features/activity_dock.rs | gate |
| `/api/runtime/capabilities` | settings | settings_connections.rs | gate + panel |
| `/api/runtime/capacity` | settings, usage, sidebar | surfaces/settings/limits.rs; surfaces/usage/view.rs; shell_rail.rs | gate + panel |
| `/api/runtime/service-tiers` | session | composer/selector.rs | gate + panel |
| `/api/runtime/telemetry` | session | composer/context.rs, command_client.rs | gate |
| `/api/orchestrator/status` | session | composer/command_client.rs | gate + panel |
| `/api/setup/cli-updates` | setup, settings | shell_features/update.rs | gate |
| `/api/cortex/proposals` | activity | surfaces/activity/proposals.rs | gate |

`[hash]` uses the production parameter name for the native commit path
inventoried as `[id]`.

## Held Next-only

| Candidate | Reason |
| --- | --- |
| `/api/panel/problem-dossiers` | GET calls `reconcileProblemDossiers`, which persists dossier/remedy state. |
| `/api/panel/devices` | Handler requires verified loopback in addition to operator authority. The adapter stamps `unverified-proxy`; a bearer cannot satisfy the local-peer condition. |
| `/api/panel/o8-update-summary` | `getReleaseNotes` writes a disk cache on GET. |
| `/api/tasks` | `getTaskPool` calls `getProjectsLedger`, which bootstraps and writes the project ledger when absent; project context reads share that bootstrap path. |
| `/api/tasks/[id]/preview` | Native client uses POST/DELETE; production route has no GET. |
| `/api/repo-spec/asset` | Native client uploads with POST; production route has no GET. |
| `/api/orchestrator/comparison-diff` | GET has a write path. Held; with the security lane. |
| `/api/orchestrator/backend-models` | GET probes and writes model disk caches; key resolution also has side effects. |
| `/api/orchestrator/pull-request-context` | GET accepts refresh queries that call `ensureGitHubPullRequest` and update the mirror. |
| `/api/setup/identity` | `getInstanceIdentity` creates persisted instance/boot IDs when absent. Existing producer registration is preserved; no surface entry is added. |
| `/api/cortex/diagnostics` | GET calls `flushTimingBuffer`, which writes timing data to disk. |
| `/api/cortex/codebase-memory` | GET calls `ensureCodebaseMemoryBootIndex`, starting indexing and persistent writes. |

Seven additional GETs remain held because `listRepos()` repairs and
persists changed remote metadata (`src/lib/repos/registry.ts`). This applies
transitively to scoped workspace reads, even when the route body only reads files:

| Candidate | GET call chain |
| --- | --- |
| `/api/panel/file-asset` | `resolveRoot` -> `resolveRegisteredRepoScope` -> `findRepoByLocalPath` -> `listRepos` |
| `/api/v2/files` | `resolveFileTarget` -> `resolveRegisteredRepoScope` -> `findRepoByLocalPath` -> `listRepos` |
| `/api/v2/files/quick-docs` | `resolveRoot` -> `resolveRegisteredRepoScope` -> `findRepoByLocalPath` -> `listRepos` |
| `/api/visualizations` | `listTranscriptVisualizations` -> `resolveVisualizationTarget` -> `resolveRegisteredRepoScope` -> `listRepos` |
| `/api/worktrees/retention-usage` | `listRepos` |
| `/api/cortex/cross-repo-proposals` | `readCachedCrossRepoProposals` -> `proposeAcrossRepos` -> `listRepos` |
| `/api/panel/prs/[id]/timeline` | `resolveRepoSlug` -> `listRepos` for non-slug repository queries |

No eligible handler needs `next/headers`, cookie context or edge runtime.
In-memory read caches and bounded observation processes remain in the production
handlers. Held entries remain in `NEXT_ONLY_NATIVE_PATHS`. Existing producer/viewer
registrations (including setup identity, file assets and v2 files) are preserved;
this inventory tracks surface membership, not the whole pre-existing registry.
The expanded inventory walk also exposed ten pre-existing native literals
missing from the hold list: orchestrator stop-packet/packet-transcript,
runtime action, panel connect/attach/mobile-pairing, mobile devices/devices/revoke,
and setup mcp-config/claude-desktop/external-client. They are named explicitly in
the hold list so the full scan can complete; no method is registered for them.
They remain outside this slice. Revoked visualization workers retain the
production handler's 404 refusal, with no document content.

## Changed files

- `src/lib/ws-server/native-http-registry.ts`
- `src/lib/ws-server/native-http-handlers.ts`
- `src/app/api/visualizations/[id]/route.ts`
- `src/lib/visualizations/read.ts`
- `src/lib/visualizations/service.ts`
- `tests/o8d-next-surfaces-real-path.test.ts`
- `docs/operations/o8d-a1-reads.md`

## Verification receipt

The visualization detail GET now imports the existing read/ownership functions
from `src/lib/visualizations/read.ts`; `service.ts` re-exports those same
functions. This removes the read route's import of publication preflight and
browser preview tooling. No store, ownership check or response shape is copied.
The first post-registration bundle attempt failed resolving browser-preview
modules; the extracted read boundary makes the production bundle build again.

Bundle: 11,690,152 -> 12,165,292 bytes (+475,140). Both measurements use
`node scripts/check-server-bundle-size.mjs`. The existing budget passes unchanged;
the largest new lazy output is the 280,244-byte visualization D3 source, followed
by the visualization document/route output (60,197 bytes).

Red receipt (before registry edits):

```text
serves A1 session GET /api/panel/branches with its production auth and Next stopped
AssertionError: expected 404 to be 401
serves A1 diff GET /api/panel/commits/[hash] with its production auth and Next stopped
AssertionError: expected undefined to deeply equal [ 'GET' ]
preserves packet-worker lane diff and visualization ownership through o8d
AssertionError: expected 404 to be 200
Tests 21 failed | 23 passed (44)
```

Fail-then-pass names: all 17 matrix rows use
`serves A1 <surface> GET <path> with its production auth and Next stopped` in
`tests/o8d-next-surfaces-real-path.test.ts`. The persisted authorization case is
`preserves packet-worker lane diff and visualization ownership through o8d`.
All 17 retained A1 cases and that persisted visualization read failed before the
registration and pass in the final capped surface run. The red run also included the timeline and comparison-diff candidates subsequently held
for GET write paths, and an existing inventory walk exceeded its old
30-second limit under cold imports. The inventory walk and fixture startup now
allow 120 seconds. The initial fixture-only startup timeout was excluded from
the fail/pass claim. Full raw red output is retained locally in
`.o8-a1-evidence/red.log`.

The final read-side-effect audit found a write path in the production
comparison-diff GET. The path remains Next-only; its implementation is
unchanged, and the detail is with the security lane.

Final focused results (all Vitest invocations use `--maxWorkers=2`, one suite at a time):

- Surface socket test: 42 passed, including all 17 A1 GET cases, with Next closed.
- Surface and related integration tests: 9 files passed, 1 file failed;
  87 tests passed, 1 pre-existing failure.
- Related unit tests plus the earlier interrupted-run composer failure file:
  8 files / 41 passed. The composer file passed all 14 cases without UI changes.
- `npm run typecheck:fast`: passed.
- Full type check: passed using `npm run verify:routes -- --maxWorkers=2`
  followed by `node scripts/typecheck.mjs`, equivalent to `npm run typecheck`
  while capping its nested Vitest invocation. Route-shape check: 4 passed,
  450 intentionally filtered cases skipped.
- Changed-file ESLint, rule check, classification-manifest check and final
  bundle check: passed.

The additional integration failure is
`tests/cortex-observation-worker-authz-real-path.test.ts` >
`keeps unauthenticated remote mutation denied at the global gate`: the test
expects 401 for a remote Host, while the existing middleware returns 421
(`Misdirected Request`). The test, handler and middleware have no diff from HEAD.
Replaying that request against a snapshot from
`git show HEAD:src/middleware.ts` also returned
`{"status":421,"body":{"error":"Misdirected Request"}}`.
The write-auth assertion remains outside this GET registration change.

An initial full-suite attempt was interrupted by host memory exhaustion and
is not counted as a completed suite. The resumed full run uses
`npm test -- --maxWorkers=2`, after the focused and type checks, with no suite
overlap. It completed with exactly the five known failures:

```text
Test Files  2 failed | 1319 passed | 3 skipped (1324)
Tests       5 failed | 10161 passed | 5 skipped (10171)
```

The failures are the three master-key cases in
`src/lib/providers/instances.test.ts` and the two performance cases in
`src/lib/acp/output-redaction.generated.test.ts`. No related implementation was
changed. Raw output is retained locally in
`.o8-a1-evidence/resume-full-unit.log`. No build or test remains pending.

Decision: commit the seven scoped files locally and hold. No push, pull request,
version change or release is included.

Classification is verified with
`node scripts/classify-tests.mjs --check-manifest`. This slice introduces no
fixed-date fixtures; optional dated-fixture probes from the initial broader
classification command were stopped.
