# Focus-aware keymap, review round 1

Same branch, based on current `origin/main` at
`f795b9c3c`. The new main delta adds surface-boundary CI and tests; native runtime source is unchanged.
No release, version, deployment,
publishing, dependency or packaging files changed.

## Registry composition

The real test surface now registers `key_down`. Compiling the production binary
and tests reproduced E0560 before restoring that field and its default. The
fallback runs only for unbound events after focused actions; text-input and
terminal context paths skip it. The fixture-backed registered-hook test covers
successful routing and refusal to preempt a focused field.

`check_composition.py` additionally copies the actual reference surface from
`19fad6fe279abac62486a3646d7209547bd2e0ec`, adds its registration, stages the
compile-time stylesheet fixture, and runs the real `cargo check --all-targets`.
The temporary root is canonicalized on all platforms. The original head fails
with E0560; the corrected tree builds. The probe never changes another branch.

```sh
python3 native/o8-next/evidence/keymap/round1/check_composition.py --surface-ref origin/feat/next-shortcuts-4548 --base e7ebed5e1
python3 native/o8-next/evidence/keymap/round1/check_composition.py --surface-ref origin/feat/next-shortcuts-4548
```

## Hidden-window bindings and documentation

Production hidden-window tests independently reproduced each missing binding:
Cmd+/, Cmd+2, Cmd+Alt+Right and reference Escape. They now pass, including reverse
cycling, an absent numbered surface, and focus restoration. These bindings live
in the central action map; the reference owns a tracked modal focus context.

Every one of the **794 test rows / 793 production rows** fires through GPUI in
its declared context, in isolation and in the complete map, with text, terminal,
list and empty focus paths: **6,352 dispatch cases**. Reference contents and
canonical-key uniqueness remain checked. Product attribution is removed from
the touched source headers and verification document, with a fail-first check.

Tests: `src/keymap_review_tests.rs`, `src/keymap_tests.rs`, and the registered
fixture surface in `src/surfaces/fake.rs`. Primary keymap verification passes
**16 tests**, with the release measurement ignored in the ordinary run and
passed explicitly. The registered-hook test passes separately.

`keymap.rs` remains the sole file attaching raw listeners: its text-protocol
bridge and the requested optional registry fallback. Surface shortcut bindings
stay in the keymap; the shell hosts the compatibility callback for unbound keys.

## Palette cost and release measurements

The failing geometry test showed opening the palette shrinking the retained
transcript viewport from **696 px to 396 px**. The palette now uses an overlay,
so that viewport stays **696 px**. GPUI reuses the unchanged surface's layout,
paint and dispatch tree through its supported cached-view API. Notifications
still invalidate changed content. The keymap is installed once per app and is
not rebuilt when opening the palette.

The optimized hidden-window benchmark dispatches the real palette action,
flushes effects, draws the first CPU scene, and asserts its painted revision.
Closing is also painted before the next sample. Ten warmups precede 80 samples;
the median budget is **under 2 ms**. The controlled comparison holds the corrected
action map and callback compatibility constant, changing only the previous flow
layout and uncached content versus the overlay and retained view. Measurements
ran serially after the other verification workloads finished.

| Release CPU endpoint | Before median / p95 | After median / p95 |
| --- | --- | --- |
| First CPU scene, 80 samples | 0.785 / 0.862 ms | **0.562 / 0.725 ms** |
| Dispatch stage, median | 0.410 ms | 0.391 ms |
| Paint stage, median | 0.384 ms | 0.170 ms |
| Existing shell test, two forced refresh frames, 20 samples | 1.190 / 1.295 ms | 1.154 / 1.602 ms |

The review supplied **6.44 ms median / 36.50 ms p95**, against a **1.5 ms**
baseline. Those desktop observations are separate from these Linux headless CPU
measurements. This environment could not reproduce the desktop timing or verify
its new value. Local medians were already below 2 ms before optimization; the
fail-first performance regression is the viewport reflow, and the explicit
release budget passes after the fix. No GPU or compositor claim is made.

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml review_palette_release_cpu_frame_budget -- --ignored --nocapture --test-threads=1
```

## Completion

- Native: **146 passed**, **4 ignored**, the known baseline Activity-order test
  in #4717 filtered; **7 CLI tests passed**. Native registration: **143 -> 151**.
  The fourth ignored test is the release benchmark, which passed explicitly.
- Full `npm test`: **9,058 passed, 5 skipped**, 1,242 passing files, 222.70 s.
- `npx tsc --noEmit` with an 8192 MiB heap, `typecheck:fast`, test classification,
  touched-file ESLint, rule-check, Rust formatting and Clippy passed. ESLint has
  no applicable Rust/Python rules; rule-check has no eligible TypeScript files.
- Red and green receipts and structured performance values are beside this file.
  Initial receipts remain in the parent directory. Remaining external checks:
  desktop timing on macOS, GPU/compositor presentation, and real accounts.
