# Task card verification

The native test first failed on the missing status pill. The route test first failed because the lane activity endpoint was absent. Three native Workers tests and the production-route test now pass. The activity test checks three numbered steps and the same card origin after expand and collapse. The fixture gives recorded messages distinct timestamps so the server's UUID tie breaker cannot reorder same-millisecond samples.

The full native run completed with 165 passed, 1 failed and 3 ignored. The failure is the Activity palette adjacency assertion reproduced on clean main in item 1. The optional local HTTP server is now built and its saved-history test passes.

Clippy, the isolated surface-boundary build, both type checks, touched TS tests, classification, ESLint and the changed-file rule check pass. The hermetic completion run reached 9,083 passed with one account-identity assertion failing under concurrent load; its isolated retry is recorded separately.

The PNGs show the expanded native card captured from a private display using software rendering, and the existing desktop worker components under All Glass. macOS system material, exact font shaping and visual parity remain for platform review under #4711. Conflict and steer actions are the next item.
