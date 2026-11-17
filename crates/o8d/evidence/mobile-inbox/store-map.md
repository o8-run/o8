# Mobile inbox store and process ownership

| Input/work | Owner and behavior |
| --- | --- |
| Eight-second full/sessions inbox caches | TS memory in mobile/inbox.ts; only an existing,unexpired,structurally empty snapshot is privately attested. GeneratedAt/mode/sourceLabel/note preserve its actual metadata. |
| snapshot-inbox.generation | Existing TS invalidation publisher writes atomically; admission consumes changes and clears the same canonical caches. External and local invalidation both defer the first read to TS. |
| Empty advisory finalization | Original TS finalizer reads the existing judgment/operator setting. No item exists to score,reorder or attach referee facts. Provider configuration/locking remains with that owner; no key value enters context or corpus. |
| Chat histories,IDE state,runtime registry,PTY/process discovery | Original TS runtime and inbox owners,including cache misses,fresh requests,nonempty sessions and orphan cleanup. Rust does not replace or suppress their work. |
| Approvals,continuations,review units,workspace review,GitHub idle drafts | Original TS owners,including approval expiration/reconciliation and live review/discovery. Any resulting nonempty/unsupported snapshot defers. |
| SQLite and schema/migration markers | Fixture initialization and original TS handlers own all writes. The Rust idle reader never opens SQLite and adds no writer. |
| Request count JSONL | Existing counts-only recorder writes on both transports by design; excluded from durable-domain snapshots. |

The strace receipt covers the complete disposable initialization,TS reference,native/fallback and boundary sequence. Its writable-path summary includes fixture setup and original owners,not only native answers. Every native generated response additionally checks before/after file content hashes (SQLite SHM and request counts excepted). The fixture owns CLI stand-ins,profile,clock and cleanup; external fetches are refused. Trace files stay local because raw paths are not a public artifact.

Issue #6395. No write-seat preparation,operator gate,caller trust,route deletion or Rust-only state is changed. On future rebases,preserve mobileInbox alongside settings/projects private admission context fields and retain their auth path lists.
