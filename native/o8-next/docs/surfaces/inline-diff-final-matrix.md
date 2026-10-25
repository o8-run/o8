# Inline diff final local matrix

Written before the final-round changes for #4665. All repositories, approvals and servers are disposable fixtures. GPUI events are headless test events.

| Case | Entry point | Required result |
| --- | --- | --- |
| Surface removal | Base-owned #4706 checker, no shell-work label | Only surface files plus one added registration line compile on main; removing the entry removes the inline surface and adapters |
| Palette, workspace switch and restart | Surface-owned shell tests | Inline palette opens its pane; shared shell tests match main byte-for-byte |
| Hunk include/skip, all, collapse, copy and refresh | Native controls, real worktree diff | Exact selected patch; selection survives refresh; refused empty/no-packet mutation |
| Committed packet and packet A → B → A | Native Open packet and Compare | Each packet uses its own base; same-packet explicit override survives |
| Standalone diff and long lines | Existing standalone viewer | Main's parser, renderer and approval behavior remain intact |
| Private, binary, traversal, truncated and very long input | Production routes and native cells/clipboard | No canary disclosure; bounded read-only previews and mutation refusal |
| Ordinary held Confirm | Native Confirm and production approval POST | Exactly one POST for the original approval; durable completion advances the owned base |
| Policy-held Confirm | Native Confirm with normal and unavailable initial proof | Same approval, one approval POST; read-only proof recovery sends zero POSTs |
| HEAD, review, contract, runtime, stop, restriction and dirty changes | Native Confirm and production gates | No unsafe merge; held approval remains pending; repaired state requires explicit review/Confirm |
| Late governance change | Production approval claim/publication fence | Refusal after the POST retains the card and base |
| Lost successful response | Native Confirm and durable receipt polling | One approval POST, completed receipt recovered without a second mutation |
| Missing or changed evidence | Read-only Review approval then separate Confirm | Review sends zero approval POSTs; Confirm uses freshly reviewed evidence |
| Cold/loaded server startup | Readiness receipt and production GET probes | No fixed sleep; readiness failure names host exit/deadline; no production mutation before ready |
| Route authorization and revision checks | Five focused TS route cases | Authentication, stale revision, input boundaries, held authorization and ordinary exact-once Confirm all green |

Acceptance is all 15 existing inline GPUI cases, all five route cases, the complete native test command (excluding only the known #4717 activity palette failure), touched-file Clippy, fast typecheck, and a passing base-owned boundary replay. Red and green tails are retained in the PR body.
