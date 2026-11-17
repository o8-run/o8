# Seeded route requests

`parity.ts` exports `generateRequests`, `CHAT_LIST_PARAMETERS`,
`DEFAULT_PARITY_SEED`, `mismatchReceipt` and `shrinkRequest`.

Supply a route path and domains derived from its actual parameter parsing.
The default seed is 6327; `O8D_PARITY_SEED` overrides it unless the caller
supplies an explicit uint32 seed. Retain the returned seed and caseIndex.
Default request count is 500. Missing, empty, accepted, ignored/invalid,
repeated, Unicode, boundary and combined parameters are included. Repeat
cases preserve parameter ordering to exercise first-value parsing.

Supply opaque cursors obtained from TypeScript responses only for handlers
whose domains contain `before`. The chat-list handler does not accept a
cursor, limit or offset. Its four domains follow the current GET handler.
Route fixtures must separately cover stored-record and write boundaries.

Compare normalized status/body pairs with `mismatchReceipt`. Receipts retain
seed, case index, request path and the first JSON pointer, without response
values. Use synthetic fixtures: request paths may contain fixture values.
`shrinkRequest` greedily removes query pairs while the supplied predicate
still reproduces a mismatch. Stateful predicates must reset and replay both
stores for every attempt.

This module generates requests and diagnoses comparisons; it does not run
servers or establish parity. Route tests must send at least 500 requests
through the public socket, require native markers, compare TypeScript's
responses and, for writes, compare resulting stores. Removal PRs must freeze
requests and TypeScript responses in `crates/o8d/evidence/<key>/corpus.json`.
The generator's mutation self-test checks detection at a changed candidate
field; it does not replace a route's differential test or Ubuntu CI receipt.
