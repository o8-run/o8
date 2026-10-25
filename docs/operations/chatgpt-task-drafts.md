# ChatGPT task draft preparation

Related work: #3249. This increment prepares inspectable local task drafts. It
does not create a mission, packet, workspace, queue entry or worker session.
Source acceptance and hosted/installed acceptance are separate.

## Capability boundary

The new local tools are `o8_task_options` and `o8_prepare_task`. Both require the
separate `o8:prepare-task` scope and a relay-verified account subject carried in
the signed one-minute local capability. Its expiry cannot exceed the original
OAuth grant expiry. Existing read and follow-up grants gain no permission.

The local catalog is separate from hosted app import and deployment.
`TASK_DRAFT_TOOLS` remains separate from the base `PLUGIN_TOOLS` export.
Provisioning scopes, updating the relay and activating hosted discovery require
separate operator work.

The authenticated local `/api/plugins/mcp` endpoint also accepts `tools/list`.
It returns current reviewed schemas and descriptions, filtered by the connection's
existing scopes, with a catalog revision and `Cache-Control: no-store`. Preparation
discovery verifies the current account before removing snapshots whose catalog
revision or sign-in epoch is obsolete for that same account, app client and
machine. Legacy snapshots without a revision require a fresh snapshot. Other
connections and immutable held task receipts remain intact; exact task retries
retain their original contract. Preparation independently refuses an obsolete
snapshot even when discovery has not run.

This local refresh path does not replace an upstream imported tool catalog.
Hosted discovery, action metadata and a fresh connected-app projection still need
comparison against the same app revision. Catalog refresh conveys no consent,
permission change or worker launch.

Preparation verifies an unexpired, signed desktop license against the relay
account, the current active identity and a durable sign-in epoch. Any persisted
sign-out marker holds the request. Identity is checked again after asynchronous
work, before persistence and before returning a receipt. No offline grace,
decoded identity, CLI profile or caller-supplied account substitutes for this
verification.

## Snapshot and contract

First call `o8_task_options` with the selected machine to list registered
repository and canonical project IDs. Then supply both IDs to capture a
five-minute snapshot. The server resolves the local path; callers cannot provide
one. A snapshot binds account, client, machine, session epoch, repository,
canonical project, exact Git revision, a clean workspace and current rule digest.
The digest includes tracked nested AGENTS/CLAUDE files, root instruction files,
local dispatch rules and the global AGENTS contract.

Runtime/model/effort entries come from the current registries. They are catalog
metadata, not proof of installation, account availability or execution.

`o8_prepare_task` requires that snapshot, a normalized objective, exact existing
relative files, a canonical sealed requirement contract, requested evidence and
explicit compatible runtime/model/concrete effort pins. The initial work mode
is read-only; only runtimes with the existing read-only adapter path are accepted.
File traversal, symlinks, environment files, scope overrides, unknown fields,
unsupported routing and unresolved/coerced effort are refused. Evidence and
verification text are stored as data; the preparation path executes none of it.

The workspace, membership and rules are checked fresh before persistence.
Changed revisions/rules, dirty repositories and expired snapshots hold
preparation. The sealed contract's mapped files must match the selected files.

## Durable receipt and local inspection

The protected `plugin-task-drafts` store contains one immutable intent/receipt
record for each account/client/machine/idempotency key. A canonical contract
digest binds exact arguments permanently; records and bindings do not expire
after the ordinary ten-minute idempotency window. Exact retries return the same
task ID, including after snapshot expiry or process restart. Changed arguments
conflict. Current account authorization still precedes receipt disclosure.

Cross-process key locks serialize publication. The intent and receipt are
published together by atomic rename after file sync, then directory sync.
A durable record is recoverable even if its writer died before removing its
lock. A lock without a record stays held; preparation never guesses that it is
stale or launches a second worker. A local operator must inspect an uncertain
lock before recovery.

Successful receipts say `state: held`, `executionEnabled: false`,
`dispatched: false` and `completed: false`. The declared future policy records
one read-only packet, one attempt, no fallback, no inherited execution carrier
and no automatic dispatch. These fields are an intended admission contract;
they do not assert runtime enforcement. There are no mission or packet IDs.

The operator-authenticated `GET /api/plugins/task-drafts` route lists the current
account's drafts and contracts for local inspection, with a session-current
indicator. Plugins, workers and devices cannot access it. No dispatch endpoint
or renderer review UI is included in this increment.

Plugin audits contain argument digests and task IDs, never draft text,
credentials, repository paths or results. The private draft itself retains its
contract and workspace identity for operator inspection.

## Source acceptance

The real-route fixture uses actual middleware, locally signed capabilities,
signed synthetic account licenses, real Git repositories, canonical project
membership, durable files and the existing headless loop. Native worker
execution is a guarded fake boundary so a regression cannot start a live worker.

Required coverage:

- Prepared receipts remain held, preserve an existing mission and produce zero
  launches through headless ticks.
- Concurrent exact retries publish one draft; independent processes share the
  persistence lock and a cold process can read the original receipt.
- Exact retries survive expired snapshots and publication-before-lock-removal.
  Changed arguments conflict, and an interrupted final audit never duplicates a
  draft.
- Old read/follow-up grants, other accounts, missing epochs, expired signatures,
  sign-out and switches during admission are refused.
- Returning to the same account under a new sign-in epoch does not admit an old
  snapshot or disclose its retry receipt.
- Stale workspaces, project mismatch, path escapes, symlinks, incompatible pins
  and scope/policy overrides are refused.
- Local inspection stays behind the operator principal; unfinished locks stay
  held, and local capability expiry respects OAuth expiry.

## Remaining before a ChatGPT worker run

### Owned runtime execution limit

The runtime launch path now accepts a separate `executionPolicy: single-attempt`
limit. It requires explicit native catalog model and concrete effort pins plus
the existing enforced read-only work mode. Claude Code also requires an explicit
native carrier. Defaults, local/provider model prefixes, incompatible efforts
and alternate execution carriers cannot fill or change these selections.

The policy and pins are saved on the owned session. Before spawn, the runner
re-reads them and requires a complete zero-run ledger. The prepared run consumes
the attempt before process creation; reconciliation never refunds it. Restricted
session writes sync the file, session directory and parent directory. A failed
sync holds launch. This improves crash resistance; it is not a power-loss test.

Restricted workers select direct detached spawn once. They cannot try the bridge
and then spawn another process after an ambiguous bridge response. General retry,
compatibility model recovery, cross-provider quota fallback, supervisor relaunch
and explicit/archived resume refuse the persisted policy. Stop remains available.
Ordinary sessions retain their existing recovery behavior.

Real Node child fixtures exercise failed and quota exits, cold store reload,
post-publication sync failure, pin changes during readiness and the supervisor
callback. Separate real-route tests bind the policy into persisted idempotency
requests. These tests mock sandbox preparation; native sandbox enforcement is
covered by the existing read-only worker tests. They do not prove live provider
execution, OAuth consent or ChatGPT-to-desktop launch.

This is an owned-session limit. It does not bind a permanent task intent or
authorize execution. Held drafts have no dispatch consumer and remain held.
The ordinary runtime launch route's expiring idempotency is not the permanent
draft/dispatch receipt store. A single owned process can also make multiple
provider requests; this policy is not a provider-request or allowance cap.

### Dispatch admission and live acceptance

Account transitions and held-draft admission now share the lease described below.
Future dispatch must use that boundary through permanent attempt reservation and
process creation, and revalidate the snapshot, workspace and current rules.

Worker creation must preserve existing missions, create an isolated workspace,
resolve the execution carrier explicitly and bind the runtime execution limit
to a permanent task intent. The worker's local API credentials and injected tools
must obey the read-only grant as well; an OS file-write sandbox alone is not API
authorization. It also needs an operator review
surface, stop behavior, audit reconciliation, installed acceptance and independent
security review. Actual dispatch needs its own permission and consent; a
preparation grant must never silently become execution authority.

Only after those boundaries pass should production activation and a disposable
ChatGPT web/phone-to-desktop worker run be reviewed. Hosted refresh/revocation,
account isolation, reviewer walkthrough and allowance measurement remain separate
acceptance items. Neither preparation nor provider token counts prove an
allowance-saving benefit.


## Account transition and admission source

The desktop account boundary now uses one installation-wide cross-process lease
and a durable generation journal. Every identity, sign-in epoch, sign-out marker,
license, founder record, managed token and device grant mutation commits a blocked
journal before changing legacy files. Exact process identity governs abandoned
lease recovery; elapsed time never permits stealing a live or unknown owner.
Synchronous callers refuse contention instead of blocking the event loop.
Release retries database contention asynchronously; only this process can recover
its own logically inactive exact reservation, without stealing an active lease.

Only a complete verified account-license sync publishes ready state, bound to
identity, epoch and the exact license fingerprint. Admission still verifies the
license signature, expiry and account subject without offline grace. Existing
legacy files alone are insufficient; missing, corrupt and interrupted journals
hold admission. Explicit sign-out survives marker aging and token timestamps;
only a completed fresh-sign-in transition allows ordinary refresh again.

License responses, managed refreshes, manual license verification, free-token
issuance, subject-based GET eviction and returned device grants compare their
captured generation inside the lease before writing or clearing state. Device
cleanup checks token ownership under that same lease. Managed refresh cannot
anchor an absent identity or adopt a generation newer than its originating sync.

Held draft persistence and local inspection use `withTaskDraftAccountAdmission`.
The awaited callback retains the lease through its operation, and cannot mutate
account state. Future worker dispatch must perform final workspace validation,
permanent attempt reservation and actual process creation inside this callback.
No dispatch tool is enabled by this change.

Real-route tests cover late license success and no-license cleanup, stale subject
reads, managed success/rejection responses, explicit sign-out, persistence failure
and safe verified recovery. Independent-process fixtures prove exclusion through
actual child creation and recovery after transition/ready-publication crashes.
The child is a local fixture, not a provider CLI or hosted ChatGPT worker. Tests
do not prove power-loss durability, live OAuth refresh/revocation, older processes
that bypass this protocol, installed acceptance or production activation.

Tracked in [#3308](https://github.com/o8-run/o8/issues/3308), as a prerequisite
for controlled worker dispatch in [#3249](https://github.com/o8-run/o8/issues/3249).

## Controlled OpenRouter worker

An explicitly selected OpenRouter catalog entry can prepare a held read-only task
using Claude Code as the CLI carrier. Copy the offered model, `provider-default`
effort and complete provider policy; native effort presets do not apply. Ordinary
worker defaults are unchanged. Missing credentials or incompatible pins hold the
task without native fallback.

The parent gateway owns the provider key; the isolated child receives only a
revocable local attempt token. The admitted task supplies current applicable
instructions and relative workspace copies. The child can use only Read, with
four inference requests, 2,048 output tokens per request and a 90-second lifetime.
Each request is persisted before forwarding. The reported-cost stopping threshold
is $0.01; the final charged request can exceed it. Missing billing evidence holds
further requests. Stop, account changes and worker exit close the attempt.

Completed results expose bound worker evidence and separately attributed provider
usage. Actual-route tests substitute the CLI and upstream; the native sandbox
test checks filesystem isolation. A private native source trial also exercised
the actual CLI and provider. These are separate from installed ChatGPT acceptance,
production activation, direct hosted launch and subscription allowance savings.
The preparation grant still requires local review and Launch unless the separate
hosted launch capability below has been activated and explicitly consented.

## Separate bounded hosted launch

Source for #3376 adds `o8_launch_task` and `o8_stop_task` under the distinct
`o8:launch-task` scope. Existing read, follow-up and preparation grants cannot
perform either action. The schema export remains dormant until the reviewed
relay flag, account-provider scope and host consent are activated. This source
does not establish installed or live hosted acceptance.

Launch accepts only the exact prepared task ID and contract hash for the current
account, sign-in epoch, original client and computer. Its first supported route
is the offered read-only Claude Code carrier with the fixed OpenRouter model,
provider-default reasoning and immutable bounded policy above. Native providers,
changed pins and wider permissions are refused. The user must explicitly request
execution; preparation itself still starts nothing.

The first grant's client, computer and expiry are saved on the permanent attempt.
Source verification precedes reservation; expiry is checked synchronously before
the reservation and immediately before actual process creation. Account and task
admission also surround binding and final workspace checks. Expiry during setup
holds that attempt without starting a child. Duplicate launch calls inspect it,
including after failure or Stop; they never create a replacement worker.

Hosted Stop names that same task and hash and requires current scoped account
authorization. It revokes further provider requests and targets only the bound
attempt. Local operator Stop remains available under its existing safety policy.
Neither hosted action grants task writes, approval, merge, release, arbitrary
process control, saved default changes or automatic fallback.

Actual-route fixtures cover old-scope refusal, client/hash/account/epoch isolation,
expiry during verification/setup/final spawn, one launch, Stop and replay. The CLI,
OS sandbox and upstream are substituted in those fixtures; native source trials,
installed execution and the real ChatGPT consent flow remain distinct evidence.
