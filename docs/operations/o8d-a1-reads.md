# o8d A1 read registrations

Scope: #5243 and #5422. The initial A1 slice registered seventeen GET paths.
The follow-ups bring the table to twenty-nine GET paths using the same production
handlers. No new POST, PATCH, PUT or DELETE registration is included. Shared shell tools are
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
| `/api/runtime/acp-registry` | settings | surfaces/settings/providers_add.rs | gate + panel |
| `/api/runtime/capacity` | settings, usage, sidebar | surfaces/settings/limits.rs; surfaces/usage/view.rs; shell_rail.rs | gate + panel |
| `/api/runtime/service-tiers` | session | composer/selector.rs | gate + panel |
| `/api/runtime/telemetry` | session | composer/context.rs, command_client.rs | gate |
| `/api/orchestrator/status` | session | composer/command_client.rs | gate + panel |
| `/api/setup/cli-updates` | setup, settings | shell_features/update.rs | gate |
| `/api/panel/o8-update-summary` | settings | shell_features/update.rs | gate |
| `/api/cortex/proposals` | activity | surfaces/activity/proposals.rs | gate |
| `/api/cortex/cross-repo-proposals` | activity | surfaces/activity/proposals.rs | gate |
| `/api/panel/problem-dossiers` | activity | surfaces/activity/decisions.rs | gate + panel |
| `/api/panel/file-asset` | session | files_panel/media.rs | gate |
| `/api/v2/files` | session | files_panel/io.rs | gate |
| `/api/v2/files/quick-docs` | session | files_panel/quick_docs.rs | gate |
| `/api/visualizations` | session | transcript_visualizations.rs | gate + visualization |
| `/api/panel/prs/[number]/timeline` | pull_requests | surfaces/pull_requests/model.rs | gate |
| `/api/review/last-turn` | diff | diff_ui_scope.rs | gate; `git worktree list` and `git diff --name-only` run on the read-only child boundary (#5652), so the read takes no `.provider-keys.lock` |
| `/api/tasks` | session | browser_panel/remote/client.rs | gate + panel |
| `/api/cortex/codebase-memory` | settings | settings_indexing.rs | gate |
| `/api/cortex/diagnostics` | settings | settings_indexing.rs | gate |
| `/api/orchestrator/packet-transcript` | sidebar | surfaces/sidebar/thread_list_client.rs | gate + panel; Codex discovery runs `sqlite3 -readonly` on the read-only child boundary (#5652), so the read takes no `.provider-keys.lock` |

`[hash]` uses the production parameter name for the native commit path
inventoried as `[id]`. The timeline similarly uses production `[number]` for
the native path inventoried as `[id]`.

## Database bootstrap on a cold data directory

Opening the database on a cold data directory (schema creation, migrations,
lazily created tables) is process bootstrap, not a GET side effect. The native
transport runs in the same ws-server process that already opens and migrates
SQLite for the registered session reads, so registering another GET adds no
new migrator and no second writer. This holds only when:

1. The open uses the shared migration code unchanged, with no route-specific DDL.
2. It creates schema only, never rows the handler owns.
3. Handler-level writes still block registration: caches, reconciliation,
   flushes, ledger bootstraps, and creating user-visible directories.
4. Identity is decided case by case: tokens, instance or boot IDs, and keys.

`/api/panel/problem-dossiers` is registered under this rule. Its GET no longer
reconciles: a dossier reconcile interval runs in the ws-server whether or not
the heal-bot is on, and skips the ticks the running heal-bot already covers.

## Held Next-only

| Candidate | Reason |
| --- | --- |
| `/api/panel/devices` | Handler requires verified loopback in addition to operator authority. The adapter stamps `unverified-proxy`; a bearer cannot satisfy the local-peer condition. |
| `/api/tasks/[id]/preview` | Native client uses POST/DELETE; production route has no GET. |
| `/api/repo-spec/asset` | Native client uploads with POST; production route has no GET. |
| `/api/orchestrator/comparison-diff` | GET has a write path. Held; with the security lane. |
| `/api/orchestrator/backend-models` | ACP probing writes the model cache and takes the credential-policy store lock before spawning. Moving the catalogue cache alone cannot make the GET read-only. See the orchestrator audit below. |
| `/api/orchestrator/pull-request-context` | Refresh queries update the mirror through a reader shared with paired devices. The existing context POST is operator-only; moving all callers to it needs an authorization decision. See the orchestrator audit below. |
| `/api/setup/identity` | `getInstanceIdentity` creates persisted instance/boot IDs when absent. Existing producer registration is preserved; no surface entry is added. |
| `/api/setup/detect` | CLI detection launches probes through the shared child-process boundary and provider store lock, reads login material, and can repair CLI symlinks via `scanAndLink`. Held at the credential/process boundary. |

One of the seven R1 candidates remains held after removing registry repair from
`listRepos()` and separating signature computation from persistence:

| Candidate | Auth basis | GET call chain that writes |
| --- | --- | --- |
| `/api/worktrees/retention-usage` | gate + panel | `GET` -> `resolveManagedWorktreeStorageTarget` creates the default root. Independently, host-volume and directory telemetry invokes subprocesses through the shared provider boundary, which creates `.provider-keys.lock` and prepares credential policy. Moving the root creation alone does not make this GET read-only; the credential boundary remains unchanged. |

No eligible handler needs `next/headers`, cookie context or edge runtime.
In-memory read caches and bounded observation processes remain in the production
handlers. Held entries remain in `NEXT_ONLY_NATIVE_PATHS`. Existing producer/viewer
registrations (including setup identity, file assets and v2 files) are preserved;
this inventory tracks surface membership, not the whole pre-existing registry.
The expanded inventory walk also exposed ten pre-existing native literals
missing from the hold list: orchestrator stop-packet/packet-transcript (the
transcript GET has since been registered),
runtime action, panel connect/attach/mobile-pairing, mobile devices/devices/revoke,
and setup mcp-config/claude-desktop/external-client. They are named explicitly in
the hold list so the full scan can complete; no method is registered for them.
They remain outside this slice. Revoked visualization workers retain the
production handler's 404 refusal, with no document content.

## A1 more-reads audit

`/api/runtime/acp-registry` already writes no persistent state. Its production
GET calls `readAcpRegistry`, which fetches bounded public catalog metadata with
no credentials, redirects disabled and `cache: no-store`. The only cache is in
memory. Refresh and stale fallback keep the same behavior in the native process.
No write moved, no new trigger was needed, and the route source stays in place.
The native caller is Settings' provider picker; the web picker uses the same GET
and its separate existing preparation POST. That POST remains Next-only.

The other three scoped paths remain held for the call chains in the table above.
Fixing the credential boundary is outside this slice. Neither review commit nor
review push is registered; both remain Next-only POSTs.

More-reads verification receipt (`--maxWorkers=2` on every Vitest invocation):

```text
npx vitest run tests/o8d-more-reads-real-path.test.ts --maxWorkers=2
Source registration changes only reverted; tests and fixture retained:
FAIL registers the production ACP GET for the native settings caller
AssertionError: ACP settings GET registration: expected undefined to be defined
Tests 1 failed | 1 passed (2)

npx vitest run tests/o8d-more-reads-real-path.test.ts tests/o8d-native-route-inventory-real-path.test.ts tests/o8d-next-surfaces-real-path.test.ts --maxWorkers=2
Tests 91 passed (91), Test Files 3 passed (3)

npx vitest run tests/o8d-more-reads-real-path.test.ts tests/o8d-native-route-inventory-real-path.test.ts --maxWorkers=2
After restoring the source registrations: Tests 5 passed (5)

node scripts/classify-tests.mjs --check-manifest
Manifest matches resource-owning source markers.
```

The cold-directory test calls the production GET with only the public fetch
boundary substituted. First read, cached read, forced refresh and stale fallback
leave the directory empty, including no provider lock, token, catalog file or
database. The socket fixture substitutes the same public catalog boundary;
production middleware, handler and method refusal remain real with Next stopped.
No persistence trigger test applies because this registration moves no write.

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

## Task ledger follow-up

`getProjectsLedger()` now builds the missing default ledger in memory, including
the same SQLite and virtual-repository projections. Project context and task
brief reads use that same read-only path. `initializeProjectsLedger()` persists
the default ledger and its active-project metadata during ws-server startup,
before the native bridge or HTTP listener starts. Existing ledgers are preserved;
project mutation paths still persist their changes.

`/api/tasks` uses the production Next GET under `session`, matching the shared
browser-panel caller. The native registration permits GET only. The native
surface test verifies startup persistence, stops Next, serves the task GET, and
checks missing/wrong credentials and unsupported mutation methods.

`tests/o8d-tasks-read-only-real-path.test.ts` compares non-database files and
database rows before and after a cold GET, then a populated GET with project
context and task briefs. It also verifies initialization persistence and
idempotence. The first-run project fixture explicitly runs initialization,
matching production startup rather than relying on a project-list GET write.

Fail-before receipt, keeping the tests and reverting only the four implementation
files to the branch base:

```sh
npx vitest run tests/o8d-tasks-read-only-real-path.test.ts tests/o8d-native-route-inventory-real-path.test.ts --maxWorkers=2 -t 'GET leaves|covers native client'
```

The task assertion fails with `GET must not create projects.json: expected true
to be false`. The inventory also fails on the existing native caller
`diff_ui_scope.rs: /api/review/last-turn: expected false to be true`, both with
the implementation reverted and restored. That path remains outside this slice.

After restoring the implementation, these focused commands pass:

```sh
npx vitest run tests/o8d-tasks-read-only-real-path.test.ts tests/task-pool-history-real-path.test.ts tests/empty-project-projection-real-path.test.ts --maxWorkers=2
O8D_BINARY="$PWD/crates/o8d/target/debug/o8d" npx vitest run tests/o8d-next-surfaces-real-path.test.ts --maxWorkers=2 -t 'A1 session GET /api/tasks'
```

The first command passes seven tests across three files. The second passes the
new native transport case, with the other eighty-five cases unselected. The
daemon was built with `cargo build --locked --manifest-path crates/o8d/Cargo.toml
--features experimental-ws`. No full suite or project typecheck ran in this slice.

Retention usage remains held. A disposable production-GET probe on an empty
temporary data directory, with no registered repositories, confirmed that
telemetry creates `.provider-keys.lock` even while `worktrees` remains absent.
The probe passed and was removed. Resolving that independent write requires a
separate telemetry/provider-boundary decision; this slice leaves it unchanged.

## R1 follow-up

`listRepos()` now projects local origin changes without taking a mutation lock
or writing the registry. It also avoids the Git subprocess on this read path:
the shared child-process boundary writes lock state in the data directory,
even for a Git read. File-only metadata reads cover ordinary repositories and linked worktrees.
Unreadable metadata and complex local Git config (includes, URL rewrites, worktree
extensions, quoted or escaped URLs) retain the saved value until explicit repair.
The bounded `worktreeMetadataReadLimit()` early return is preserved.

`repairRepoRemotes()` retains the existing Git resolution, mutation lock and
compare-before-merge rule. Only a matching repository id/path whose stored
`remoteUrl` still equals the pre-lock value is repaired. It runs at the start
of `scheduleRepoMaintenance()`, the existing asynchronous add/repoint spec-write
path. This gives both writers one repair call site, adds no timer, and still
repairs if the subsequent spec ingest fails. Repair failure does not prevent
spec ingest.

The visualization listing GET and target-resolution bodies moved unchanged
into `src/lib/visualizations/read.ts`. The Next route re-exports that same GET,
and the native transport loads it directly. Publication and browser preview
imports stay on the write path. The moved GET and authorization bodies were
compared byte-for-byte with `origin/main`; the socket test also checks owned
and foreign packet listings. No new mutation method is registered.

The R1 socket fixture uses its existing `O8D_TEST_BINARY` override pointed at
`$CARGO_TARGET_DIR/debug/o8d` on hosts with an external Cargo target directory.
The default worktree-relative binary path does not locate that build.

R1 regression receipt, using the integration config and `--maxWorkers=2`:

```text
origin/main 9e41bfbc78a9d48a81ee675d883fc945394f93c5, new test copied into an isolated snapshot:
FAIL returns the moved origin on a GET-path listRepos without changing registry bytes or mtime
AssertionError: expected Buffer[...] to deeply equal Buffer[...]
Tests 1 failed | 3 skipped (4)

branch:
PASS returns the moved origin on a GET-path listRepos without changing registry bytes or mtime
PASS persists a changed origin through explicit remote repair
PASS repairs moved remotes during the existing add maintenance writes
PASS projects a linked worktree origin without creating state or erasing an offline remote
Tests 4 passed (4)
```

The red invocation filters to `-t 'GET-path listRepos'`; no test is disabled in
source. The branch runs the whole file. The test compares registry bytes,
nanosecond mtime and directory entries, so a registry rewrite or newly created
provider/registry lock file is observable.

Completed related file counts:

| Test file | Passed |
| --- | ---: |
| `tests/repo-remote-refresh-real-path.test.ts` | 4 |
| `tests/o8d-native-route-inventory-real-path.test.ts` | 3 |
| `tests/o8d-next-surfaces-real-path.test.ts` | 83 |
| `tests/repo-repoint-contract.test.ts` | 3 |
| `tests/repo-package-manager-contract-real-path.test.ts` | 3 |
| `tests/repo-storage-pressure-policy-real-path.test.ts` | 4 |
| `tests/workspace-manifest-registry-real-path.test.ts` | 2 |
| `tests/transcript-visualizations-real-path.test.ts` | 8 |
| `src/lib/repos/thread-git-context.test.ts` | 2 |
| `tests/panel-repos-add-response.test.ts` | 3 |
| `tests/panel-repos-readiness-scope.test.ts` | 8 |

The completed focused runs total 110 integration tests and 13 related unit
tests. The surface file passes alone with Next stopped, including authenticated
scoped file/preview/quick-docs/visualization reads with unchanged registry bytes
and mtime, plus owned and foreign packet visualization listings.

Global verification limits in the supplied shared dependency installation:
`npm run typecheck:fast` completes with 116 diagnostics outside touched files,
including missing dependency types and the existing Next configuration type
mismatch. The server bundle check fails on the same three unresolved module
paths in both the branch and an isolated `origin/main` snapshot. No dependency
or build-budget change is included. An optional broad maintenance run was
interrupted after three timeouts (one case passed); it is not a completed
suite. The full unit attempt was also interrupted after repeated file-load
failures and is not claimed as a passing completion gate.

The representative hermetic unit load failure is
`src/components/desktop/thoughts/use-orchestrator-stream/fresh-turn-options.test.ts`:
zero tests execute because an SDK import cannot resolve. The identical import
failure reproduces on the isolated `origin/main` snapshot. That snapshot probe
disables the filesystem module cache to avoid a separate shared-symlink cache
`ENOENT`. Touched-file ESLint and `rule-check --base=origin/main` pass.
The classification manifest check and final diff whitespace check also pass.

## Cortex read follow-up

`/api/cortex/cross-repo-proposals` now computes missing or empty legacy stack
signatures in memory. It preserves proposal results, including `force=1` and
`force=true`, without creating or replacing `stack-signatures.json`. Signature
persistence belongs to the existing `ensureStackSignatureBoot` startup hook and
registry add/remove/repoint recomputes. The startup hook is called by
`startStatusBootHooks` during Next process initialization; a GET never starts it.
The default project-membership path uses shared database bootstrap and reads
project/membership rows without inserting any.

`/api/cortex/codebase-memory` and `/api/cortex/diagnostics` are registered
for Settings using the production GETs. The design uses a persisted state bridge:
Next remains the sole boot-indexer owner through `src/lib/startup/next.ts` and
`startStatusBootHooks`. The existing one-shot guard is unchanged. The native
HTTP entry point marks its process as a Cortex reader before loading any handler. If the existing
bootstrap POST loads Next startup hooks there, both the indexer and probe
publisher refuse ownership. Every boot or repo transition atomically replaces `codebase-memory-live.json`, including
pending, indexing, cached, ready, deferred, skipped and error entries.
Successful HEAD receipts remain in `codebase-memory-state.json`. Neither GET
imports or starts the indexer, and the native process has no indexer trigger.
A cold read returns the empty state without creating a directory or file.

Timing producers persist each sample in `recall-metrics.db`. An immediate SQLite
transaction owns each append, legacy import and FIFO eviction; existing Next
and native timing producers cannot overwrite one another's snapshots. Retention
stays capped at 1,000 samples. The legacy `recall-metrics.json` is read without
mutation until the first recording transaction imports it once. GETs open only
existing files in read-only mode and reload timings on every request. Outcomes
are counted through a read-only connection without schema bootstrap. Next also
publishes its process-cwd counters on each counter/in-flight transition to
`cortex-process-cwd.json`, so the extra diagnostics field agrees across readers.
GET performs no flush, migration, database creation or background work. The
existing bearer gate and method policy are unchanged.

The owner transport fixture runs the real indexer against an owned Git repo and
an MCP stdio fixture that holds its response until released. With the fixture
Next server stopped, the public native socket observes indexing, then ready,
the successful HEAD receipt, the owner's timing and its process-cwd counters.
The native process first reads empty state before the separate owner starts,
which also proves that reads do not retain a first-load snapshot.

Cortex owner fail-before receipt (all source changes restored from HEAD;
new tests, fixtures, inventory edits and documentation retained):

```text
npx vitest run tests/o8d-cortex-owner-real-path.test.ts tests/o8d-next-surfaces-real-path.test.ts --maxWorkers=2 -t 'cold-data-dir GETs|registers both production|serves A1 settings GET /api/cortex/'
FAIL cold-data-dir GETs create nothing and never kick the indexer
AssertionError: GET must leave a cold data directory empty: expected [ …(66) ] to deeply equal []
FAIL registers both production GET handlers and no mutation methods
AssertionError: /api/cortex/codebase-memory production GET registration: expected undefined to be defined
FAIL serves A1 settings GET /api/cortex/codebase-memory with its production auth and Next stopped
FAIL serves A1 settings GET /api/cortex/diagnostics with its production auth and Next stopped
AssertionError: expected 404 to be 401
Tests 4 failed | 94 skipped (98)
```

All source changes were then restored. The focused owner tests also cover a
missing data directory, pending and error snapshots, unchanged bytes and mtimes
across GETs, legacy metrics import exactly once, live-outcome filtering and
native bootstrap refusing indexer ownership. Two concurrent recorder processes
retain all 50 samples in the native reader. No new credential, auth, redaction,
network-bind or mutation registration changes are included.

Owner verification after source restoration:

```text
npx vitest run tests/o8d-cortex-owner-real-path.test.ts tests/o8d-cortex-owner-transport-real-path.test.ts tests/o8d-native-route-inventory-real-path.test.ts tests/startup-stage-diagnostics.test.ts src/app/api/panel/status/route.test.ts src/lib/supervisor/process-cwd-budget-real-path.test.ts --maxWorkers=2
Test Files 6 passed (6); Tests 40 passed (40)

O8D_TEST_BINARY="$CARGO_TARGET_DIR/debug/o8d" npx vitest run tests/o8d-next-surfaces-real-path.test.ts --maxWorkers=2
Test Files 1 passed (1); Tests 90 passed (90)

node scripts/check-server-bundle-size.mjs
Total 12,507,942 bytes; budget 11,674,791; delta +833,151; check passed

node scripts/classify-tests.mjs --check-manifest
Manifest matches resource-owning source markers

npm run rule-check -- --base=HEAD
Zero violations
```

Changed-file ESLint and `git diff --check` also pass.

Owner source files:

- Codebase-memory: `src/app/api/cortex/codebase-memory/route.ts`,
  `src/lib/codebase-memory/indexer.ts`, `src/lib/codebase-memory/live-state.ts`.
- Diagnostics: `src/app/api/cortex/diagnostics/route.ts`,
  `src/lib/cortex/diagnostics.ts`, `src/lib/cortex/diagnostics-state.ts`,
  `src/lib/runtime/process-cwd-snapshot.ts`, `src/lib/panel/status-boot.ts`.
- Shared process and transport: `src/lib/cortex/owner-process.ts`,
  `src/lib/ws-server/native-http-registry.ts`,
  `src/lib/ws-server/native-http-handlers.ts`,
  `src/lib/ws-server/native-http-routes.ts`.
- Proof and inventory: `tests/o8d-cortex-owner-real-path.test.ts`,
  `tests/o8d-cortex-owner-transport-real-path.test.ts`,
  `tests/fixtures/cortex-state-owner.ts`, `tests/fixtures/cortex-index-mcp.mjs`,
  `tests/o8d-native-route-inventory-real-path.test.ts`,
  `tests/o8d-next-surfaces-real-path.test.ts`, `tests/test-classification.json`,
  and this operations note.

The transport tests select the locally built o8d fixture binary with
`O8D_TEST_BINARY`. No project
typecheck or full test suite was run under the explicit box limits.

Cortex verification receipt (all Vitest runs use `--maxWorkers=2`, serially):

```text
# Only src/lib/cortex/stack-signature.ts restored from HEAD; new tests retained.
npx vitest run tests/o8d-cortex-reads-real-path.test.ts --maxWorkers=2 -t 'cold legacy GET'
FAIL cold legacy GET returns proposals without creating or changing any owned file or directory
AssertionError: GET must not create the signature cache: expected true to be false
Tests 1 failed | 3 skipped (4)

# Source fix restored.
npx vitest run tests/o8d-cortex-reads-real-path.test.ts tests/o8d-native-route-inventory-real-path.test.ts tests/o8d-r2b-read-only-gets-real-path.test.ts --maxWorkers=2
Cortex: 4 passed. Dossiers: 2 passed. Inventory: 2 passed, 1 failed.
FAIL covers native client routes with their production registration owners
AssertionError: diff_ui_scope.rs: /api/review/last-turn: expected false to be true

# Inventory test and native registry temporarily restored from HEAD.
npx vitest run tests/o8d-native-route-inventory-real-path.test.ts --maxWorkers=2
Same /api/review/last-turn assertion: 1 failed | 2 passed (3).
# Both files restored to the implementation after the baseline run.
```

The new Cortex tests call the production GET with three registered manifest
fixtures and a repo-scoped directive. They check the absent and empty signature
cache, forced reads, unchanged file bytes and nanosecond mtimes, no new project
or membership rows on a cold database, and persistence through the existing
startup hook. Shared SQLite files and migration markers are bootstrap artifacts
under the cold-database rule above. All other files and directories are compared.
The unrelated route-inventory drift is reproduced on the baseline registry and
inventory test and is left outside this slice.

Changed-file ESLint, `git diff --check`, and
`node scripts/classify-tests.mjs --check-manifest` pass. No project typecheck or
full suite was run under the task's explicit execution limits.

```text
npx vitest run tests/o8d-next-surfaces-real-path.test.ts --maxWorkers=2 -t 'serves A1'
Tests 25 passed | 61 skipped (86)
```

The A1 socket matrix includes the new `activity` cross-repo proposals GET with
Next stopped. It verifies missing/wrong bearer refusal, the authenticated
production response, GET-only surface registration, and 405 refusal for all
unregistered write methods. The earlier focused `-t 'cross-repo-proposals'` run
also passed (1 passed, 85 skipped). Raw receipts are retained locally under
`.o8-a1-evidence/cortex/`.

## Orchestrator read audit

Both orchestrator candidates remain held. No GET or mutation registration is
added, and their `NEXT_ONLY_NATIVE_PATHS` entries remain in place.

### Backend models

`GET /api/orchestrator/backend-models` calls `probeAcpModels`, which creates
`acp-models/<backend>.json` after a nonempty probe. Before that cache write,
`new AcpClient` calls `withProviderStoreLock` during credential-policy
validation and process creation. That boundary creates `.provider-keys.lock`
and executes an exclusive SQLite transaction. It is separate from shared
application database schema bootstrap. Removing the catalogue write would
still leave this credential-policy write on a cold cache or `refresh=1`.

The read also resolves provider credentials through `resolveOpenRouterKey`
and the Local ACP launch/environment path. The existing fingerprint and
output-redaction checks depend on that launch configuration. The audit stops
at this boundary; credential resolution, locking and redaction are unchanged.
A cache-only GET would lose the current cold-cache and forced-probe behavior.

Native `composer/selector.rs` requests this path for the session model picker.
Web callers include `AcpModelPicker.tsx`, `ComposerPicker.tsx`,
`LocalAcpSection.tsx` and `MuseConnectionSection.tsx`; settings callers request
`refresh=1`. A follow-up needs an agreed probe trigger that preserves those
results while retaining credential-policy admission. No cache write has been
moved in this slice.

### Pull-request context

`GET /api/orchestrator/pull-request-context` calls `readPullRequestContext`.
For a repository/number query, `refresh=1`, or `refresh=missing` without a
repository identity, calls `ensureGitHubPullRequest`. Its targeted
`syncPullRequest` upserts the PR mirror. This supplies provider-backed immutable
repository/PR IDs even for an external PR absent from the mirror.

`ConversationPullRequests.tsx` and the operator MCP `conversation-prs.ts`
handler resolve those IDs with `refresh=1` before sending the existing link
POST. That POST currently requires the complete immutable identity; it does
not accept a repository address as a refresh request. `PullRequestConversations.tsx`
also requests `refresh=missing` for reverse lookup from both desktop and mobile.
Its mobile endpoint calls the same reader and permits paired devices. The
context POST permits only operators, and paired-device POSTs are denied by
the existing middleware and handler. Moving refresh to that POST for every
caller therefore needs an authorization decision or a separate maintenance
design that covers previously unknown PRs. Dropping refresh would change the
external-import and missing-identity results. The audit stops here without
changing either authorization boundary or either GET's behavior.

Native `surfaces/sidebar/pr_links.rs` only requests saved links by `threadId`;
that caller does not use refresh. Registration still covers the entire
production GET, including its repository/number refresh queries, so that
read-only caller alone cannot justify registering the route. No mirror write
has been moved in this slice.

### Audit verification

Only this document changed; production source and tests are unchanged.

- `npx vitest run tests/conversation-pr-context-real-path.test.ts -t 'imports an accessible external PR|gives a paired mobile read|roundtrips the built CLI' --maxWorkers=2`:
  external import and paired-device read/denied mutation passed (2 tests).
  The CLI roundtrip failed during bundling because the supplied dependencies
  cannot resolve `ink`, `@muse-code/sdk` and `@earendil-works/pi-durable`
  (including its SQLite storage subpath). There were 24 filtered tests.
- `npx vitest run tests/o8d-native-route-inventory-real-path.test.ts src/app/api/orchestrator/backend-models/route.test.ts --maxWorkers=2`:
  4 tests passed, including both backend-model route tests. The inventory's
  production-source scan failed with
  `diff_ui_scope.rs: /api/review/last-turn: expected false to be true`.
  That caller and its registration are outside this slice and unchanged.
- `git diff --check`: passed.

No source change was made, so there is no source-reversion fail-before/pass-after
receipt or moved-write trigger to verify. No native socket registration test
was added or run because both paths remain Next-only. No typecheck or full
suite was run, following this worktree task's targeted-test restriction.
