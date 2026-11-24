---
name: o8-dev
description: Scoped guidance for o8 dispatch, packet review, lifecycle recovery, and self-hosting hazards. Load when a task uses those paths, not for ordinary repository work.
---

# Developing o8 through its control plane

This skill covers work that exercises o8's own dispatch, packet, review, and release machinery. The
canonical task policy is `AGENTS.md`: one execution agent owns ordinary work directly, and dispatch
is a cost and independence decision.

## Dispatch decision

- Execute ordinary changes in the current task. Do not dispatch because a task is large, spans several
  files, or the fleet is available.
- Dispatch only when the bounded benefit exceeds briefing, review, retries, and context cost, or an
  independent seat is required for risk. Pin the delegated model and effort without changing the
  operator's selected main model or saved defaults.
- If the defect is in dispatch itself, use an execution path independent of the broken component.
  Keep work isolated from the main checkout, review the actual diff, and preserve governance gates.
- After two correction rounds on delegated implementation, stop repeating the loop and report or
  escalate the remaining defect. Use scripts or bounded waits for routine polling.
- Evaluate the whole accepted task. Subscription agents share allowance, and token counts alone do
  not establish weekly capacity or savings.

## Dispatch and review loop

Use this loop only after the dispatch decision above is satisfied.

1. **Dispatch:** create a bounded mission with explicit scope, done condition, verification, compact
   handback, model, and effort. Require explicit pathspecs and never `git add -A`.
2. **Watch:** `wait_for_mission_ready({missionId, timeoutMs:1800000})` — long-poll that returns the instant a packet hits review/terminal; that return re-enters your turn (this is how you "get pinged" — o8 workers are NOT harness-tracked, so re-arm it or piggyback on a ginsu/background-task notification). Verify liveness via `get_mission_status` + the owned rollout tails.
3. **Review every delegated diff:** inspect the raw diff and verification receipts. Read high-risk
   authentication, authorization, schema, payment, destructive, and security evidence directly.
4. **Merge or salvage:**
   - Clean + gate passing → `approve_and_merge`.
   - Gate blocked on a credential/artifact leak but the CODE is verified correct → **salvage by pathspec**: copy the specific good files from the packet worktree into main, verify no `.tmp-owned-push-*`, tsc+test, commit with explicit pathspec. (Never merge a branch carrying a leaked token.)
   - Rejected on real findings → `steer_packet` (warm, cheap) or `rerun_with_feedback` (fresh).

## Review discipline (non-negotiable)

- **Anti-duplication (Q ruling):** before fixing, recon what already exists; adjudicate every delegated diff against existing machinery — if a worker rebuilt something, compare old vs new, keep the BETTER one, delete the loser. Brief workers to REUSE named existing pieces. (Proof: #1537 was 35 lines wiring dormant mac_perms machinery, not new FFI.)
- **Reachability / fail-on-old-code:** a new seam needs a test through the REAL entry point that FAILS on the pre-fix code. Prove it: strip the guard, run the test, confirm it fails, restore. A green test that also passes on old code proves nothing (the "encodes the premise" trap).
- **Trust the governance gate:** the auto-reviewer catching a leaked worker token / a rule violation IS the product working — surface it as a win, fix the source.

## Lifecycle traps (all hit + fixed the night of 2026-07-18; keep the doctrine)

- **Activity IS liveness, unknown KEEPS.** Every lane/worktree lifecycle guard (zombie reaper, worktree pruner, self-review-stall) must treat fresh transcript activity (owned-session `runs/*.jsonl` mtime — `reaper-liveness.ts ownedTranscriptMtimeMs`) or a live process as alive, and FAIL CLOSED on any uncertainty (probe error / unresolvable = keep, never reap). Heartbeats are worker-VOLITIONAL (`o8 packet heartbeat` CLI only — no server pulse), so a long turn freezes them while alive; never reap on heartbeat staleness alone.
- **npm-test-in-a-worktree kills the real fleet (#1585 class).** Vitest imports owned-session modules, which default their root to the REAL `~/.o8/owned-<runtime>`; the import-time orphan sweep then SIGINTs live production workers. `tests/setup-isolated-data-dir.ts` MUST redirect ALL owned-root env vars (CORTEX_IDE_OWNED_CODEX_ROOT, …_CLAUDE_CODE_ROOT, O8_OWNED_{GEMINI,OPENCODE,CURSOR,GROK,PI}_ROOT) to temp, AND markActiveRunOrphaned must never signal a foreign PID when `O8_TEST_DATA_DIR_PINNED` is set.
- **Ship-wedge: worktrees drown `next build`.** `.cortex-worktrees` clones live inside the repo, so `next build` file-traces them → OOM (exit 134). Keep worktree retention ON (`worktreeMaxCount`/`Gb` = 20); if it OOMs, quit o8.app (releases the backend's file-watch handles), `git worktree remove --force` all + prune + `rm -rf .next/cache`, then re-ship. Better fix (queued): relocate the worktree root to `~/.o8/worktrees` — OUT of the repo tree (no drown), same APFS volume (CoW clones stay cheap). NOT an external drive (CoW breaks cross-volume; never T7 — read-only camera masters).
- **`.tmp-owned-push-*` token leak → never `git add -A`.** o8's owned-push tmp artifact holds a live worker token; a bare add sweeps it into the commit and the gate rejects the merge. It's gitignored now, but worker briefs must still say explicit-pathspec-only.
- **Backend file-watches fool `lsof +D`.** The next-server backend holds handles across every worktree, so a live-process guard sees them all as "live" and won't prune while the app runs — distinguish backend watches from real worker cwd (open follow-up).
- **Green tests + green tsc ≠ green build (the server-only client leak).** `npm test` stubs `server-only` (tests/stubs/server-only.ts) and tsc doesn't run webpack, so a CLIENT component that imports a module which transitively pulls `import 'server-only'` (e.g. via the lane/orchestrator backends → codex.ts → haiku-adapter.ts) passes tsc + vitest but FAILS `next build` ("server-only ... not supported in the pages/ directory"). Fix: split the client-safe vocabulary (types/consts/pure fns) into a `*-shared.ts` with zero runtime imports; the client imports `-shared`, the server module re-exports it. Merges that add a client component reaching into a server module are the risk. **The ship runs `next build` and catches this — so a merge that's tsc/test-green can still break the ship.** Before shipping a batch that touched client↔server import boundaries, run `npm run build` yourself; don't trust tsc+vitest alone. (#1570 broke the .624 build exactly this way.)

## Disk hygiene (the internal disk fills and breaks ships)
Before shipping, check free disk space. If cleanup is required, inventory candidates first, verify
that no live process or unpushed work owns them, and keep destructive cleanup operator-gated. Use a
separate read-only audit only when independence or the bounded benefit justifies its cost.

## Dogfood-first

Every dispatch is also a test of o8's dispatch path. Record blocking or recurrence-relevant friction
with sanitized evidence. If dispatch fails, stop identical retry loops and use the cheapest correct
independent path or report the blocker.

Shipping discipline lives in the `ship` skill. Load it only when work becomes release-related or
commit-ready under the current repository rules.
