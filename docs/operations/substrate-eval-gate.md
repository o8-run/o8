# Substrate Eval Gate

**Status:** active. Read-only instrumentation only — this doc defines *when* we
start an evaluation, not what we replace SQLite with.

## Purpose

Cortex memory currently runs on SQLite + a directory of markdown directives.
That stack is fast, simple, local-first, and ships inside the Tauri bundle
with zero ops. We want to keep it for as long as it's *measurably* fine.

This document defines the threshold values that trigger a substrate
**evaluation** — not a migration. Crossing a threshold means we open a
spike, gather data, and write a follow-up doc that proposes (or rejects) a
specific replacement. It does not mean we cut over.

We refuse to pre-optimise. The eval gate exists so we always have a written
answer to "is SQLite still the right substrate, or are we papering over
real pain?".

## Thresholds

The runtime check at `/api/cortex/diagnostics` (Settings → Diagnostics →
Recall Health) compares the live numbers against these constants. The
numbers in the UI are read straight from this doc's source of truth in
`src/app/api/cortex/diagnostics/route.ts` (`SUBSTRATE_EVAL_THRESHOLDS`).

Trigger an evaluation when **either** condition is true:

| Trigger | Threshold | Why |
|---|---|---|
| `outcomes_count` | `>= 5,000` rows in `session_outcomes` | At ~5K rows, even a hot SQLite table starts to lose row-cache friendliness for `LIKE` and `JOIN` queries on the recall path. The decay job (#745) keeps live rows bounded, but if we cross 5K live rows we have a real workload, not a demo workload. |
| Recall p95 latency | `>= 200ms`, sustained over a 7-day window | Operator-perceptible lag on the recall card and dispatch context starts at ~200ms p95. One-off spikes happen during compaction or boot — we only care about sustained signal. |

Both numbers are conservative on purpose. They're easy to relax later once
we know what the actual replacement looks like.

## Sustainment definition

The 7-day sustained signal needs at least **5 days out of 7** with
p95 ≥ 200ms. This filters out:

- single-day spikes from compaction or a heavy import
- the first day after a fresh install (cold cache, low sample count)
- regressions that self-heal within a couple of days

The Diagnostics endpoint surfaces both the 24h and 7d p95. The 7d window
is the trigger; the 24h is a leading indicator.

## What "trigger eval" means

Crossing a threshold does **not** mean migrate. It means:

1. Open a spike issue (`spike: substrate evaluation`) and link this doc.
2. Gather a week of representative recall traces (`<dataDir>/recall-metrics.json`).
3. Identify the *specific* hot path — is it directives, outcomes, symbol
   graph, or runtime recommendation? The Diagnostics tab's per-call-site
   table tells us which.
4. Pick at most three candidate substrates. Score on:
   - Local-first (no cloud dependency, ships in Tauri)
   - Operational simplicity (still single-binary, zero-ops)
   - Drop-in shape (Drizzle-shaped repository so we don't rewrite call sites)
   - License compatibility
5. Prototype the top one in a branch behind a feature flag. Re-measure.
6. Decide and write a follow-up doc.

The eval explicitly does **not** assume any particular replacement. We list
options here only to bound the scope of the spike — not to recommend one.
Whichever wins on measurement, wins.

Plausible substrates the spike should at least consider:

- A graph-flavoured embedded store
- A vector store with metadata filters
- A different SQLite layout (covering indexes, virtual tables, FTS5)
- A hybrid of the current setup with one new tier (e.g., Redis for hot
  keys) only on the call site whose p95 is dominating

We rank these on the spike's measurements, not on this doc's guesses.

## What we instrument

`src/lib/cortex/diagnostics.ts` owns the timing buffer. Every recall query
on the dispatch / recall path is wrapped with `withTiming(label, fn)` or
`withTimingSync(label, fn)`. Current call sites:

| Label | Surface |
|---|---|
| `recall.recent-outcomes` | `/api/cortex/recent-outcomes` (Recall card outcomes row) |
| `recall.directives` | `/api/cortex/directives` (Recall card directives + dispatch trailers) |
| `recall.symbol-graph` | `build-context.ts` (dispatch context injection symbol trace) |
| `recall.proposer-outcomes` | `proposer.ts` (auto-directive proposer SQLite read) |

The buffer at `<dataDir>/recall-metrics.json` keeps the most recent **1000
samples** with FIFO eviction. That's about 4 weeks of normal usage on a
single-operator install. The buffer hydrates on boot and lazily flushes
every 10 appends, so the disk write rate is bounded.

Adding a new recall site to the eval gate is a one-line wrap:

```ts
import { withTiming } from '@/lib/cortex/diagnostics';

const rows = await withTiming('recall.<my-site>', () => existingQuery);
```

## What we do NOT do

- We do not log timings to a remote service. Everything is local-only.
- We do not block recall on the timing wrapper — the wrapper swallows nothing
  but the logging itself, and re-throws every error from the wrapped fn.
- We do not migrate any data. This issue (#749) is instrumentation only.
- We do not recommend a specific replacement substrate in this doc — that
  decision happens after the spike, with measurements in hand.

## Owner

The Cortex memory subsystem. Touch the thresholds here and the constants
in `src/app/api/cortex/diagnostics/route.ts` together.
