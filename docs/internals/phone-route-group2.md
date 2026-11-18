# Phone TypeScript route group 2

This group builds on #6454. It adds ten route paths to the existing WS HTTP
registry, reusing their TypeScript exports without changing a handler, store,
model call or state owner.

The caller reference is o8-mobile cd7365c53038c6e8a24d1043ad2f620f6bf427cd.

| Route | Methods added | Current phone caller |
| --- | --- | --- |
| /api/mobile/automations/[id]/enabled | POST | app/(settings)/scheduled-tasks.tsx, enabled JSON |
| /api/mobile/automations/[id]/run | POST | same screen, clientMutationId JSON |
| /api/mobile/genui/stream | GET POST | o8/ask-models.ts, ask.ts and generated-surfaces.ts |
| /api/mobile/pairing-discovery | GET | o8/client.ts, nonce query |
| /api/mobile/pull-requests | GET | o8/pull-requests.ts, existing view/repo selectors |
| /api/mobile/search | GET | o8/search.ts, query selectors |
| /api/mobile/usage | GET | app/usage.tsx |
| /api/panel/search | GET | o8/search.ts, query/workspace/repo selectors |
| /api/setup/orchestrator-backends | GET | o8/orchestrator.ts |
| /api/worktrees/diff-summary | GET | o8/orchestrator.ts and thread-changes.ts, session/thread selectors |

Ask GET is the existing model catalogue. Ask POST keeps its existing JSON
validation, authentication, generation routing and streaming response. This
registration does not introduce a model invocation or invoke one in tests.
The automation routes keep their original principal checks, mutation IDs and
handler actions. No broad dynamic automation path is registered.

The pairing discovery route remains deliberately credential-free. Its existing
handler signs a caller nonce and the current public API/WS ports with the
existing server identity. It returns no bearer or enrollment material.

Focused proof is the exact method/path matrix plus a Node HTTP test of the
actual dispatcher. Before registration, discovery returns 404 and Ask POST
returns 405. Afterwards, discovery signs the real advertised front-door port
even when the old WS port differs; changing the nonce invalidates the signature.
Missing nonce returns 400, E2EE opt-out returns 404, bad Ask bearer returns 401,
and original malformed/missing Ask body validation returns 400 before model
routing. Existing discovery tests retain their original response assertions.

The coordinated candidate still depends on the master TypeScript-read guard and
WS startup-bootstrap follow-up. Combined-head Next-absent boot, relay, CLI and
update acceptance remain in that integration campaign.
