# Startup read oracle

GET /api/panel/ws-info and GET /api/setup/identity each have 500 generated requests, seed 6327. Neither handler accepts query parameters, so the shared generator uses the empty parameter profile. Records come from the real TypeScript handlers through the public app socket with Next stopped and native reads disabled.

The seeded fixture supplies IDs and credentials. The corpus binds the runtime API port, WebSocket port and fixture token to $FIXTURE_API_PORT, $FIXTURE_WS_PORT and $FIXTURE_WS_TOKEN. The identity version binds to the checked-in package version through $FIXTURE_APP_VERSION, so release bumps do not invalidate the oracle; a different returned version does not bind and fails. It contains no credential values. Each test first checks the committed oracle against the live TypeScript capture, then compares the unmodified live TypeScript and Rust responses, including actual port numbers and credentials, with zero differences. Status, cache/CORS headers, key presence, null/missing, scalar values and array order are strict. Only requestId, epoch and generatedAt use the shared normalizer.

Additional socket cases cover live/dead port probes, permissive integer parsing, bounds, resolver cache asymmetry, changed API-port timestamps, missing or overridden IDs, and credential creation fallbacks. TypeScript remains the sole writer for credentials, identifiers and port stores. The startup bridge passes a snapshot of the actual TypeScript resolver to avoid guessing its process cache.

Source: src/app/api/panel/ws-info/route.ts, src/app/api/setup/identity/route.ts, src/lib/panel/api-port.ts, src/lib/panel/instance-identity.ts and src/lib/ws-auth.ts. Captured on the independent startup branch based on d6d5ff47c. Issue #6365; generator #6327. No route deletion or auth-policy change.

The six auth cases per route match the original TypeScript statuses. Identity discovery is public for missing/wrong bearer, spoofed headers and wrong Host; its read-only bearer and cross-origin write cases remain refused. The test preserves those outcomes. Probe listeners explicitly destroy their owned sockets at cleanup.

Current `gates.json` uses an optimized release binary, ten warmups and 100 measured requests per route and transport. It retains every timing sample and the matching twelve auth outcomes. No debug latency is reported.

| Route | TS p50/p95 ms | Rust p50/p95 ms |
| --- | ---: | ---: |
| /api/panel/ws-info | 5.89/7.60 | 8.11/9.79 |
| /api/setup/identity | 5.52/7.43 | 10.11/11.32 |

Rebased onto main88657435a after chat-list merged. The shared table proves all seven inherited/startup entries, with chat-list and startup fixture seeds retained. Fresh focused/Rust/typecheck/lint/rules checks pass; current release timings replace the previous table.
