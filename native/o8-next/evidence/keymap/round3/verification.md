# Retained regions while typing

Base: `07142e10942c4208374564640d5d81d205c85456`.

The existing loaded-shell typing benchmark failed before the change:

```text
native_composer_loaded_shell_typing_benchmark ... FAILED
shell typing must reuse unchanged session regions
footer: 13 -> 14; transcript: 13 -> 14
test result: FAILED. 0 passed; 1 failed
```

Caching the whole session refreshed every retained child when the composer
invalidated that ancestor. Surface-owned rendering now lets the session retain
its sibling regions directly. Other registered views keep their existing cache.

After the change, the same production-shell benchmark passes all 100 inputs:
each edit paints, with no shell/session notifications or extra region renders.

```text
native_composer_loaded_shell_typing_benchmark ... ok
test result: ok. 1 passed; 0 failed
native_composer: test result: ok. 17 passed; 0 failed
keymap: test result: ok. 18 passed; 0 failed; 1 ignored
keymap focus matrix: 6592 dispatch cases
```

The ignored release timing benchmark was not run. These are headless CPU-scene
checks, not a desktop presentation-timing measurement. Fast typecheck, the full
hermetic test gate (filesystem module cache disabled), touched Rust formatting
and diff whitespace checks passed. No TypeScript source changed.
