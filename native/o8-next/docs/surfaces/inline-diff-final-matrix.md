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
| Cold/loaded server startup and held-card phase | Readiness receipt and production GET probes, including approval-bound spoken evidence | No fixed sleep; HEAD and diff fingerprint verified before ready; failure names host exit/deadline; no approval POST during a readiness probe |
| Route authorization and revision checks | Five focused TS route cases | Authentication, stale revision, input boundaries, held authorization and ordinary exact-once Confirm all green |

Acceptance is all 15 existing inline GPUI cases, all five route cases, the complete native test command (excluding only the known #4717 activity palette failure), touched-file Clippy, fast typecheck, and a passing base-owned boundary replay. Red and green tails are retained in the PR body.

The 15 native acceptance cases retain these function names under `src/surfaces/diff/`:

| File | Test | Observable assertion |
| --- | --- | --- |
| `tests.rs` | `inline_diff_is_reachable_from_shell` | Palette opens InlineDiff and closing/restarting restores the registered pane |
| `tests.rs` | `inline_diff_hunks_copy_refresh_and_merge_refusal` | Hunk controls produce an applicable exact patch, refresh retains selection, invalid merge and disconnected-server states refuse |
| `corrections.rs` | `committed_packet_uses_lane_base_and_enables_merge` | Committed files use the lane base and Merge reaches the production route with the displayed HEAD |
| `corrections.rs` | `inline_diff_omits_standalone_title_and_mode_controls` | Inline chrome omits standalone controls and keeps workspace-scoped content |
| `boundaries.rs` | `inline_boundary_canary_never_reaches_cells_clipboard_or_logs` | Synthetic credential bytes stay out of presentation, clipboard and fixture logs |
| `boundaries.rs` | `inline_boundary_very_long_line_is_read_only_before_paint` | A 300,000-byte line remains bounded and read-only |
| `round2.rs` | `packet_switch_resets_the_previous_packets_base` | A to B to A uses each lane's base and retains only the same-packet explicit override |
| `round2.rs` | `standalone_long_line_review_keeps_the_shared_behavior` | Standalone review of a 20,000-character line persists its approval |
| `round2.rs` | `held_merge_offers_confirm_and_completes_its_approval` | Ordinary Confirm sends exactly one approval POST for the original card and advances the real base ref |
| `round2.rs` | `held_confirm_rereads_head_review_contract_and_runtime` | HEAD, review, contract, runtime, stop, restriction and dirty changes refuse; repair requires explicit review and Confirm |
| `round2.rs` | `policy_held_merge_confirms_its_current_approval` | Normal and forced-evidence-outage policy holds each complete their original approval with one POST |
| `round2.rs` | `held_confirm_fences_governance_change_before_the_approval_claim` | A late review change leaves the approval pending and the base unchanged |
| `round2.rs` | `held_confirm_recovers_a_lost_completed_receipt` | A lost successful response recovers durable completion after only one POST |
| `round2.rs` | `held_approval_recovers_when_initial_evidence_is_unavailable` | Read-only evidence recovery precedes a separate exact-once Confirm |
| `round2.rs` | `changed_approval_evidence_requires_read_only_review_before_confirm` | Changed governance needs read-only review and another explicit Confirm |

The five route cases in `tests/o8-next-inline-diff-real-path.test.ts` cover authenticated diff/revision checks, merge input/idempotency checks, binary/large/path boundaries, denied held-approval authentication, and ordinary held exact-once confirmation. The registration real-path test additionally checks discovery through the unmodified host.

Commands run from the repository root:

```sh
export CARGO_TARGET_DIR="$PWD/native/o8-next/target"
cargo test --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1 --nocapture
cargo clippy --locked --manifest-path native/o8-next/Cargo.toml --all-targets --message-format=json
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast
node_modules/.bin/vitest run tests/o8-next-inline-diff-real-path.test.ts tests/next-surface-registration-real-path.test.ts --maxWorkers=1
node scripts/next/check-surface-boundary.mjs --base origin/main --head HEAD
```

The boundary checker is first compared byte-for-byte with the version on `origin/main`, then used without an exemption event. Clippy diagnostics are checked against all touched Rust paths. The target directory is removed after native verification. The full TypeScript suite is outside this final round's scope.
