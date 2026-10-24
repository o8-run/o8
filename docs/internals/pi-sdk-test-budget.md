# Managed Pi test budget guard

This is a source-only, opt-in test safeguard over the SDK prototype in #3233.
It is not an account quota service and does not authorize a live request.
The generic `createPiSdkSession` default transport remains unbudgeted; a live
test must explicitly use `createBudgetedPiTestTransport` and its one approved
persistent ledger in trusted host storage outside the tool workspace. The guarded
transport rejects a canonical ledger path inside that workspace. No UI or public route selects this test entry today.

## Retired managed contract

The dated managed pricing contract and its paid live acceptance test are retired.
`resolveLivePiTestContract()` returns `null`, so the guarded transport refuses
before route resolution or a request unless trusted offline code injects a
synthetic contract. There is no managed paid test or environment opt-in.

The generic ledger and transport remain because
`tests/pi-sdk-budget-real-path.test.ts` exercises reservation, concurrency,
crash, cancellation, usage, and expiry boundaries through real SDK workers and
SQLite. `tests/pi-sdk-live-contract.test.ts` checks request compatibility with
synthetic bounds and a pinned Date clock. Runtime model descriptions in
`src/lib/pi/sdk/live-contract.ts` remain in use by model selection, orchestrators,
workers, and durable sessions; their values no longer depend on pricing evidence.

Resolver injection remains a trusted offline seam, never a request field,
worker tool, environment JSON value, or user flag.

## What the guard enforces

`initializePiTestBudget` creates one owned ledger explicitly and exclusively.
It will not reopen and reset an existing budget. The approved limit is integer
micro-USD, at most 1,000,000 ($1). Keep this same ledger for the entire approved
test, including new sessions and process restarts. Creating another ledger is
another budget, requiring its own authorization; a model cannot select it.

`createBudgetedPiTestTransport` wraps the actual host fetch boundary. It checks
an exact model and endpoint, contract expiry, the complete serialized request
(including system text, tools and history), output limits, and absence of a
model fallback list or multiple completions. The SDK transport's client retries
and redirect following remain disabled.

Before any HTTP request, a SQLite immediate transaction reserves the contract's
worst-case all-in charge. Integer arithmetic rounds up fractional micro-dollars.
The input reserve covers the contract's full billable-input bound, not a chars/4
estimate. The output reserve includes the entire billable-output bound and a
fixed per-request charge allowance. This is deliberately conservative.

A ledger allows only one outstanding request. Concurrent processes cannot use
the same reservation or exceed its aggregate limit. Completed requests retain
their entire reservation; low token usage never refunds money. Failed, aborted,
incomplete or unverifiable-usage calls remain unknown and block subsequent
requests. A process crash leaves a pending reservation, also blocking the next
process. There is no automatic reset or reconciliation shortcut.

The ledger stores only a contract fingerprint, integer limits and reservation
states. It stores no prompt, token, credential, header, model output or raw
provider error. The transport keeps existing error sanitization. These are
host-side controls, not protection from a malicious process that can rewrite
its own application files or create another budget ledger.

## Offline verification

`tests/pi-sdk-budget-real-path.test.ts` drives the full transport through a real
SDK worker and mocked HTTP responses, plus two simultaneous processes against a
real SQLite ledger. All rates and billing contracts are explicitly synthetic.
No live model, auth flow, provider request, or payment is part of the suite.

```sh
npx vitest run tests/pi-sdk-budget-real-path.test.ts --maxWorkers=1
npm run test:integration -- tests/pi-sdk-budget-real-path.test.ts
```

## Dated fixture checks

Both `npm run test:classify` and `npm run test:classification:check` audit fixed
expiry dates in source, tests, CLI, script, and configuration files. The latter
already runs on every PR. Dates within the next seven days produce a warning,
including the file, line, and UTC expiry; the warning does not fail the command
or alter the manifest.

The audit follows local imports and static JSON fixture paths, then runs each
referencing hermetic test through Vitest with Date past its latest fixed expiry.
After collection, each test ID runs in a fresh process with only its ancestor
hooks, including parameterized cases with identical names. The probe installs
an advancing future clock at worker startup, before Vitest captures Date, so
restoring timers also restores the probe clock. Default Intl date formatting
and performance.timeOrigin use the same future epoch; explicit dates and
monotonic durations retain their normal behavior. It clears collection-time
pins before the selected test's hooks, including Date prototype mocks, formatter
mocks and timeOrigin shadows. After cleanup, the original clock descriptors,
references and prototype links must be restored. Pins belong in the selected
test or its ancestor hooks; collection-time state cannot supply a runtime pin.
An unrelated suite cannot lend a later test its clock. Ordinary Date.now() use
continues to work under the advancing clock.

The probe uses the regular isolated-data setup and requires a successful report
for exactly one passing test in the expected canonical file. A failed import,
hook, assertion, timeout, clock restoration, or missing report fails classification.
A later clock-pinning hook cannot hide earlier validation.

Pin Date before the validation executes. For validation inside tests or hooks,
place `vi.useFakeTimers({ toFake: ['Date'] })` and a fixed
`vi.setSystemTime(...)` before the validating hook. For import-time validation,
pin the clock in `vi.hoisted` before importing the module, and pin it again in
the test's hook when the test also validates the fixture. Restore timers in
`afterEach` or the owning describe's `afterAll`. An explicit `now` in
`useFakeTimers` also works. Relative expiries
such as `Date.now() + 60_000` do not select a future-clock probe. The seven-day
warning still uses the classification command's actual clock.
