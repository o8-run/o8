# Settings source store ownership map

This source ownership map predates publication; current public-socket evidence
is in corpus.json and gates.json. Installed outcome is unproven. Six real GET exports executed in isolated child
processes with synthetic stores, no account credentials, unavailable CLI paths
and network disabled. Each route has500 generator cases, seed6327. Parameterless
setup/config and v2/keys repeat a single path; fixture/store variation still
needs additional cases before their future Rust gate.

Corpora retain status, parsed body and headers. Fixture-root strings are
parameterized as $FIXTURE and must be materialized for future replay; this is
fixture portability, not a permitted semantic exclusion. Other response fields
are retained. These are preparation oracles, not final frozen removal corpora.

## Read/write ownership

- panel/operator-defaults: wrapper -> handler -> operator/defaults and
  settings/operator-defaults-store. Reads settings.toml, legacy
  operator-defaults.json and scoped global/project/machine layers; native view
  reads instance identity, bot roster, Cortex SQLite and runtime/config data.
  refresh=runtime invalidates process auth caches; setup/native/default views
  include live runtime/auth/catalogue projections. Actual cold capture wrote
  migration markers, cortex-ide.db/WAL/SHM, .provider-keys.lock and
  provider-launch-policy.json. This GET is NOT a proven pure read. Existing
  TS writers include defaults POST, native scoped settings and TOML atomic
  write helpers, knowledge reconciliation and provider-launch policy helpers.
  Rust must defer cold migration/live-cache/owner cases; no second writer.
- runtime/provider-instances: reads provider-instances.json and optional local
  ACP connection. Returned environment inventory uses acp-environment.sqlite
  configuration/credentials, not plaintext secrets. Missing env DB returns an
  empty revision0 inventory in this fixture. TS create/update/delete/bind and
  connection-environment mutation own JSON+encrypted SQLite writes. No request
  writes observed here, but encrypted-store/keychain handling is not established
  by the empty synthetic inventory and remains security-sensitive.
- setup/config: reads setup.json (missing/malformed => defaults), then
  agent-setup-request.json (pending/interrupted projection; malformed =>500).
  TS setup POST writes setup.json; queue/update/renew setup-request helpers
  atomically replace request JSON. Captured pending request, no request writes.
- v2/keys: real storage-guarded GET reads provider-key snapshot and
  providers/openrouter.json. No env/credential values were seeded or inspected;
  all configured keys are absent. Provider-key mutation owns encrypted env
  writes/locking; connection check/enable handlers own OpenRouter JSON/cache
  invalidation. No request write observed; successful empty-key reads do not
  prove decryption, rotation, migration or configured-key parity.
- runtime/capabilities: id selects registered adapter declarations; unknown =>
  capabilities:null. Runtime registration/feature flags are module/process
  authority. No request writes or CLI/inference observed; imports are a separate
  initialization boundary, not proven pure by an empty request write list.
- runtime/service-tiers: backend and model parsers; >200 UTF16 units =>400.
  Codex model/list+config/read is live CLI/process catalogue state; fixture CLI
  unavailable yields36 captured503s. Claude reads claude-code-worker.json and
  selected .claude/settings.json plus process disable flag and model capability.
  Unknown backend =>empty options. No request writes observed. Existing TS
  worker-profile/settings writers own those stores; native Codex catalogue
  requires a live fallback or a separately owned saved snapshot.

## Artifacts / limits

*.corpus.json and *.summary.json:500 cases each. Service tiers455x200,9x400,
36x503; other five routes500x200. source-provenance.json records actual source
blobs versus main; store-references.txt contains rg references to each store.
request-phase-store-map.json derives opened read/write paths and exec attempts between
capture markers in the syscall traces. Full traces include setup/import/seed
activity too; request write-open flags are evidence of attempted access, not
proof of a changed row. Summaries additionally compare before/after fixture
file size/hash without saving credential material. Warm/cold/module boundaries
and other writers need the route's later real-path/stateful checks.

A separate single native-settings GET probe returned200 and produced the actual
fixture SQLite schema via sqlite3 .schema (81,172 bytes), saved as
cortex-ide.schema.sql. It adds schema evidence without repeating the3000-case
capture. The absent optional ACP credential DB is not claimed to have a schema
receipt. All13 primary/transitive source files in source-provenance.json match
current origin/main at capture time.

Bounded setup/config store-variant follow-up: setup-store-variants.json records
8 setup file variants x13 request file variants=104 real GET invocations.
Missing/malformed/null/array/string/number/empty/rich Unicode config cases and
missing/malformed/null/array/empty/pending/opened/cancelled/interrupted/needs_tools/
unknown/expired/active request cases are included. Actual exit0:88x200,16x500;
malformed or null request JSON yields setup_recovery_unavailable. Missing or
malformed setup config uses defaults; other parsed values retain TS spread
semantics, including array/string index keys. Snapshot hashes show zero file
changes per invocation. Inputs are recorded as exact file bytes; JSON null in
the file-input map means file absent, while string "null" means a present null
JSON file. Separate syscall trace and source/SHA/log/exit receipts are retained.
This is direct-function preparation, not public auth/Rust/Ubuntu proof, and it
adds store variation rather than repeating the500 parameterless path requests.

## Provider-instance store variants (recovery follow-up)

provider-store-variants.json freezes 750 actual authenticated GET calls:
10 provider JSON variants x3 Local ACP variants x5 environment-store variants
x5 query shapes. Includes missing/malformed/null/scalar/wrong-field/array stores,
duplicate and mixed entries, Unicode/disabled instances, dangling/array/prototype
thread bindings, absent/corrupt/zero-byte SQLite and configured non-secret rows.
No commands or network requests were executed for fixture ACP connections.

All750 returned200;80 requests changed the contents of a pre-existing empty
ACP SQLite file by initializing its schema. Other inputs had unchanged content
hashes. Hash snapshots do not measure chmod or prove an absence of write syscalls.
The full strace includes harness store seeding as well as GETs, so it must not be
used as a request-only write list without separating those phases. The missing
SQLite store remained absent. Corrupt SQLite and malformed configuration JSON
produce environment:null for affected instances; configured ordinary Unicode
variables preserve revision7 and exact values. Mixed/null/primitive instance
entries retain the handler's current spread behavior; no normalization assumed.
The saved valid Local ACP slot is prepended, never launched.

This corrects the absent-store-only evidence: provider-instances GET is not a
proven pure read for an existing uninitialized environment database. A Rust port
must preserve/defer that case and account for TypeScript's schema writer. This
is a parity observation, not a change to the TypeScript contract.

Exit0 and named source/log/strace/hash receipts are in the notes root and lane.
Four handler/transitive blobs match origin/main; post-run SHA verification passed.
Credentials/encryption/rotation are untested. No public socket, Rust parity,
Ubuntu CI, route state, installed result or source checkout change is claimed.
