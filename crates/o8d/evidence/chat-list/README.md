# Saved chat-list TypeScript oracle

Route: GET /api/v2/chat-history/list. Seed6327;500requests from the handler parameter domains in scripts/o8d/generated-requests.ts. The fixture is seeded by seedSessionFixture plus seedChatListEdges. All records are synthetic.

Responses were captured from the original TypeScript handler through the public app socket with native reads off and the fixture Next listener stopped. Only requestId,epoch and generatedAt use the shared normalizer. The literal $FIXTURE_ROOT replaces the fixture's owned temporary directory recursively; no user home or credential values are captured. No pagination/cursor is invented for this list handler.

The real-path test checks the committed oracle against the live TypeScript capture at the default seed,then compares500native responses. O8D_PARITY_SEED still selects a different deterministic generated replay; that replay uses its live TypeScript reference. Capture-only mode writes the frozen default corpus before the shared-table integration; it does not prove native admission. The default CI invocation has no capture-only flag.

Retained fallback causes:parked-workspace projections,local-time placeholder titles,unsupported saved encodings,and empty-record cleanup owned by the TypeScript writer. No route handler or writer is deleted by this state move.

Provenance:TypeScript handler at69c016c25;source blob 0ec6992823c9a1a8ba9d9ff361521f2ba0ea9d66. Native implementation and fixture helpers are committed beside this oracle. Associated issues:#6344 and#6327.

Review regression: expired empty unkept records now defer before archive/search filtering so the canonical TypeScript GET deletes them. The public test checks three deletions and five native fresh/kept cases. The generated replay restores the original files and timestamps and detects unexpected history content mutations. See `gc-review.json` for the red/green receipt.
