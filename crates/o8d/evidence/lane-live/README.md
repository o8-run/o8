# Live lane occupancy oracle

GET /api/lanes stays at rust-with-fallback. Only its existing view=live branch moves: active lane id, packetId, status and worktreePath, ordered by createdAt. Ordinary lane reads still reconcile state in TypeScript. Large or unsupported saved data also defers.

corpus.json freezes 201 requests with seed6327 and their TypeScript responses. It retains missing, invalid, empty, repeated, Unicode and boundary parameters, plus100 additional live projections carrying generated values for the ignored parameters. Separate actual flag-off/on daemon launches compare every response and header exactly. References never make native admission probes. The current result is108 native,93 fallback,zero differences. Successful native reads preserve serialized SQLite. The injected mutation is caught at $/body/lanes/0.

The handler and private admission share the original principal predicate. Operators and non-readonly packet-bound workers retain the live view; revoked, unbound and readonly workers retain their refusals. Eleven auth/boundary outcomes include a cross-origin POST refusal and a forged private context presented with an unbound worker credential. No caller permission, WS registration or store writer changes.

The fixture builds the real CLI using its production build options and runs worker status against both launches. Its schema and all four consumed fields match the socket response. This is CLI proof, not a GPUI launch. Owned fixture paths bind to $FIXTURE_ROOT; other values, nulls and array order remain strict.

The optimized release receipt uses10 warmups and100 samples per transport. Native is slower end to end in this shared-host fixture. gates.json retains raw release samples; no debug or installed timing is claimed. trace-summary.json records the TS fixture syscall inventory, including setup/reseeding writes rather than attributing those to the GET. See store-map.md for ownership.
