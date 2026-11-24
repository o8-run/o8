# Orchestration Playbook — how a great orchestrator runs o8

Distilled from live operation (2026-07-04/05: a 10-packet concurrent scoring
run, three fix waves, ~30 issues closed, 24 ships — all root-fixed with
evidence). Written FOR the orchestrator model driving o8 through the
`mcp__o8__*` tools or the `o8` CLI, whichever model you are. Every section is
a habit that prevented a real failure. The Brain ingests this file — ask
`o8 ask "orchestration playbook <topic>"` when unsure.

## The loop

### Park-by-park, never fire-and-forget

Dispatch → watch → review each packet AS IT PARKS → merge → batch-ship the
wave. Never dispatch and walk away; never let parked work queue up unreviewed.
One background watcher on lane status (`status NOT IN
('running','launching')`), then handle each park fully before returning to
watch. Parallel packets park at different times — that staggering is your
review bandwidth, use it.

### Verify settled before reviewing

A `review_ready` label is a claim, not a fact. Before reading a diff: (1) no
live worker process for that worktree, (2) `git status --porcelain` is clean,
(3) commits exist ahead of the base. Reviewing a half-written tree wastes a
pass; a dirty tree means the worker is still moving or died mid-write (then
salvage applies, not review).

### Diff against a FRESH base — always

`git fetch origin main` in the packet clone BEFORE `git diff main...HEAD`.
The clone's local `main` is frozen at clone time; on a busy repo another
agent's merged commits will appear inside the packet diff and read as
contamination — or worse, hide real contamination. (Live-hit: a merged
device-rollup commit looked like cross-agent WIP leakage; an hour earlier a
REAL WIP leak had happened, so this is not paranoia.)

## Reviewing

### Review the invariant, not the diff aesthetics

Every review answers: does each changed line trace to the brief? Does the fix
actually get REACHED on the real path (a guard nobody calls is not a fix —
the reachability doctrine, proven by three separate live incidents)? Do the
tests drive the real entry point, or do they mock the seam and encode the
premise? Pin the review to the exact HEAD sha; a later amend voids it.

### Touch up small, bounce big

A style-rule violation or a float-precision assertion in otherwise-correct
work: fix it yourself in the worktree, commit, review at the new sha — a
30-second touch-up beats a round-trip. Missing scope (a whole deliverable
absent, a safety test not written): steer or rerun with a PRECISE gap list —
numbered, file-pointed, nothing vague. Never approve half a safety-critical
packet "to keep things moving."

### Demand evidence, produce evidence

Close issues with file:line proof, never "this looks done." When an issue
might already be fixed, check the code before dispatching — three "urgent"
security issues turned out to be already-shipped audit work; one explorer
agent verified six suspects in two minutes. The same discipline inward: every
claim you make to the operator carries the command output that proves it.

## Recovery economics

### The ladder: steer → rerun → salvage — in cost order

A parked-failed packet with a warm thread: `steer_packet` (one cheap turn,
context intact). Steering fails or the session is unresumable: `rerun_with_
feedback` — the branch KEEPS prior commits, so tell the fresh worker exactly
what is already done and list only the gaps. Worker died with uncommitted
work: the tree/`preserved/` branch has it — commit and review it yourself
(salvage), never redispatch over the top of it. NEVER loop reset+redispatch;
two failures on the same packet means the brief or the environment is wrong —
diagnose before spending a third worker.

### Verify your own verbs fired

Packet discard has three worktree cases. If the directory still exists, o8 removes it through the normal guarded cleanup and closes only after removal is confirmed. If the directory is already absent and the lane has a clean `runtime_process_exit` receipt for its worker session, o8 stops any active review turn, records `worktree_missing`, and closes without trying to delete the missing path. If the directory is absent without that worker-exit receipt, the lane parks as `worktree_missing_unverified` and the Incident Queue offers an acknowledgement action; use `o8 packet discard --acknowledge-missing-worktree` or pass `acknowledgeMissingWorktree: true` to `close_packet_unmerged` after inspecting the packet. Without the acknowledgement a directory that exists still requires confirmed cleanup. With it, a close also proceeds when o8 cannot retire the checkout at all (a retirement left half done, or a checkout it can no longer prove is its own): o8 leaves whatever is on disk untouched, records `worktree_missing_acknowledged` or `worktree_unrecoverable_acknowledged` on the lane, and names any folder it left in place in the close note. Uncommitted work in a checkout o8 owns, or a process still running inside it, still refuses the close.

A steer that returns ok can still be a silent no-op (live-hit: every
steer-resume for hours was exiting code 2 pre-turn; the UI showed nothing).
After steering, confirm the session actually relaunched (lane event, live
process, or transcript movement) before trusting it. If a control-plane verb
misbehaves, STOP dispatching through it and fix the verb first — self-repair
beats piling work onto a broken rail.

## Root-fix doctrine

### Fix it now, natively, when diagnosis IS the fix

Mid-run failures get root-caused immediately — not filed for later, not
worked around. Split by shape: if diagnosing the bug hands you a ≤30-line
fix (an argv flag, a missing base URL, an interval leak), implement it
yourself, test it, push it. If the fix is a well-specced multi-file unit,
write the complete brief and dispatch it. The orchestrator's context is the
most expensive resource — spend it on diagnosis and judgment, not bulk edits.

### When your own fix breaks something, say so and fix that too

The orphan-exit fix leaked a timer into CI; the crash-survival probe
misattributed failures; the first ship of a patch silently missed the bundle.
Every fix gets the same adversarial verification as worker output — run the
suite it could plausibly break, and when CI disagrees with your machine,
believe CI and reproduce in a clean clone before concluding anything.

## UI parity — watch like a human

### After every state change, look at the actual app

Between packets: screenshot or eval the real webview — sidebar rows match DB
lanes, transcripts render, Settings opens, console is clean. UI==backend is
the bar; a blank footer, a lying "Merged" banner, or a missing agent row is a
bug to file-and-fix even when the backend is healthy, because the operator
LIVES in the UI. When your screenshots look wrong, measure (window size,
element rects) before assuming — the window really was 848px off-screen once.

## Shipping

### Batch per wave; verify the artifact, not the exit code

Merge the wave's PRs (CI pinned per exact head sha), full suite on integrated
main, then ONE ship. After publishing: the app may sit on the update card —
`o8 app restart --if-update-pending` (or press Restart via the webview).
After relaunch: confirm the running version, console, and one wave-specific
surface. A ship that "succeeded" once shipped a stale chunk (build cache) and
once published no release — trust only the verified running artifact.

### Briefs are architecture documents

A dispatched worker knows nothing you don't write down. A good brief names
the exact files, the mechanism to copy (point at existing precedent code),
the constraints that are non-negotiable (safety rails, style rules, test
doctrine), and the acceptance test. The quality of the fleet is the quality
of your briefs — a vague brief costs a full worker cycle; a complete one
lands in one pass.

## Where the deeper knowledge lives

- Repo rules and architecture: `CLAUDE.md` (this repo) — the middleware gate,
  style rules, vocabulary, the escalation ladder table.
- Crash survival mechanism: `docs/operations/daemon-crash-survival.md`.
- CLI and packet commands: `AGENTS.md`.
- Ask the Brain (`o8 ask` / `cortex_ask`) before grepping broadly — it has
  ingested all of the above plus the session ledger of every prior fix.
