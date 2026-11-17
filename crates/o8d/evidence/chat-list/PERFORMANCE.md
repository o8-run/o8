# Release chat-list timing and reader profile

All timing values below are from an optimized release build. Each of the five shapes has 10 warmups and 100 measured requests per transport, through the production public socket with Next stopped. Values are p50/p95 in milliseconds. Six auth outcomes per transport match exactly.

| Shape | TS end-to-end | Rust end-to-end |
| --- | ---: | ---: |
| default | 8.88/12.71 | 9.31/13.56 |
| surface=mobile-assistant | 7.91/9.84 | 8.04/11.68 |
| include=orchestrator | 7.11/10.33 | 8.34/12.00 |
| q=雪 | 6.73/38.54 | 9.04/13.60 |
| archived=only | 6.09/9.64 | 9.25/13.59 |

| Shape | Node admission | Exact reader | DB preflight | Close/dispatch | Transport/client residual |
| --- | ---: | ---: | ---: | ---: | ---: |
| default | 2.41/3.48 | 0.83/1.29 | 3.41/4.78 | 0.69/1.07 | 1.90/3.26 |
| surface=mobile-assistant | 2.08/3.27 | 0.74/1.10 | 3.01/4.40 | 0.64/0.98 | 1.67/2.49 |
| include=orchestrator | 2.11/3.08 | 0.91/1.27 | 3.05/4.41 | 0.63/0.90 | 1.60/2.59 |
| q=雪 | 2.36/3.39 | 0.82/1.33 | 3.39/5.59 | 0.73/1.17 | 1.71/2.88 |
| archived=only | 2.46/4.15 | 0.67/1.08 | 3.61/5.71 | 0.74/1.12 | 1.72/2.78 |

The previous broad reader timer included generic preflight, dispatch and connection teardown. The exact chat_list::read is now timed separately: 0.67–0.91 ms p50, 8.96% of the aggregate measured client time. The first SQL query before the reader takes 2.92–3.50 ms p50. Database opening plus that preflight accounts for 37.13% of measured client time.

Admission to the existing Node gate accounts for **25.90%** of aggregate client time across 500 native samples, with per-shape shares 25.42–26.60%. This is the per-request hop item 4 removes; no admission bypass or cached authorization was used to measure it.

## Reader profile and proposed follow-up

The fixture reads and parses 15 history files / 23,118 JSON bytes per request. History file I/O p50 totals 0.18–0.20 ms; JSON parsing 0.17–0.19 ms. These are not the largest costs in this fixture.

A separate diagnostic repeats the identical SQL query immediately on the same connection. Across 100 requests after 10 warmups, first-query p50/p95 is 9.98/24.84 ms; the repeated query is 0.04/0.16 ms. This run had different ambient timing and is kept separate from the end-to-end table. It demonstrates a large first-query cost on each fresh connection, without claiming a measured end-to-end speedup from an unimplemented pool.

The follow-up I would make is bounded reuse of read-only connections and prepared statements, keyed to canonical profile/database identity, reopening on file replacement or relevant errors. It must preserve live WAL visibility, profile containment and current error fallback, with no persistent read transaction or authorization cache. That lifecycle change needs replacement/WAL/concurrency parity coverage, so it is outside this GC correction. It is tracked in [#6373](https://github.com/o8-run/o8/issues/6373).

## Measurement and reproduction

`gates.json` is the current release result. `release-timings.json` mirrors it, and `release-samples.json` retains all per-request samples. `profile-instrumentation.patch` records the diagnostic timestamps; `warm-query-probe.patch` is the separate extra-query experiment. Both patches are unapplied in production sources. Build command and binary/source/patch hashes are in the JSON evidence. Build with `cargo build --locked --release --manifest-path crates/o8d/Cargo.toml --features experimental-session-reads --bin o8d` after applying the diagnostic patch in an isolated test checkout. Copy that binary, then reverse the diagnostic patch before any production build or commit.

Component percentiles are independently calculated and must not be summed. The transport/client value is a residual after measured admission and dispatch; it includes connection/classification, transfer, decode and diagnostic overhead. The chart uses component means so its stacked bars add exactly. Tail spikes remain in the samples. This synthetic Linux fixture is not installed-app performance and does not cover large real histories. The diagnostic release binary also passes the 500-request differential and public-socket placeholder GC regression.
