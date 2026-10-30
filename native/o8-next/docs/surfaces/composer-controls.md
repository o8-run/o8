# Composer controls, board row 22

Tracks [#5136](https://github.com/o8-run/o8/issues/5136), alongside the composer-card work in [#4712](https://github.com/o8-run/o8/issues/4712).

Baseline: `origin/ui/next-rail-parity` at `b483c22a0`. Classic reference:
`origin/main` at `99aab6a94`. The recovered implementation was uncommitted on
`ui/next-composer-controls`; it was preserved and reapplied to this rail head.

## Verification inventory before the port

The statuses below describe the untouched rail baseline, not the recovered dirty
working tree. Present means reachable through the native composer. Partial means
some behavior exists but at least one part of the described behavior is absent.

| Classic behavior (trigger, items, keys, application, calls, persistence) | Rail baseline | Port / receipt |
|---|---|---|
| Leading `/` after optional whitespace opens suggestions only for orchestrator input; ordinary text does not | Missing | Native composer slash menu |
| Command-token prefix search is case-insensitive and matches `/visualize` and `/fleet` aliases | Missing | Native command metadata and filtering |
| Commands in order: visualization, orchestrate, ask, compact, clear, focus, status, recall, handoff, rule, rules, prompts; then chat, codex, gemini, opencode routes | Missing | Same ordered items |
| Menu shows command, title/description and group; list scrolls without a visible scrollbar | Missing | Native token-styled list |
| Up/Down wrap selection; edits reset selection; Enter completes partial tokens | Missing | Real editor keyboard tests |
| Enter on an argument command without an argument inserts canonical command plus space; it does not send | Missing | Real editor keyboard tests |
| Click an argument command inserts its prefix and restores editor focus; click a no-argument command applies it | Missing | Native menu click handlers |
| Enter on an exact command with arguments applies it; aliases resolve to canonical handlers | Missing | Native command dispatch |
| Escape closes suggestions and retains the draft; unchanged input stays dismissed until edited | Missing | Real editor Escape test |
| Shift+Enter inserts a newline and IME composition does not execute a command | Present | Existing editor contract retained |
| `/visualization` sends expanded instructions with raw slash text displayed, preserving attachments and selected routing | Partial | Queue existed; local command expansion was absent |
| `/orchestrate` / `/fleet` applies the orchestration route in this conversation | Partial | Queue existed; local command handling was absent |
| `/ask` calls POST `/api/cortex/ask`, streams answer/citations and gives visible errors | Partial | Brain panel existed; composer slash entry was absent |
| `/compact` POSTs `/api/orchestrator/compact` with keepTailCount 8 and manual trigger; applies returned transcript/prelude | Missing | Native command client |
| `/clear` saves the old conversation with POST `/api/v2/chat-history`, resets `/api/orchestrator/reset-session`, and opens a fresh draft | Partial | History creation existed; slash workflow was absent |
| `/focus` resolves a packet from state, reads `/api/orchestrator/archive`, keeps matching live turns and queues focused prelude | Missing | Native command client |
| `/status` shows telemetry tokens/cost/model, mission wave and up to four active packets using `/api/runtime/telemetry` and `/api/orchestrator/status?includeCost=true` | Partial | Meter existed; command snapshot was absent |
| `/recall` searches `/api/orchestrator/archive`, appends up to three matches as context for the next send | Missing | Native command client |
| `/handoff` compacts, resets remote session and replaces the next-turn prelude; newest context retains its ending | Missing | Native command client |
| `/rule` POSTs a thread-scoped rule; `/rules` opens active and inherited rules with add/remove controls | Missing | Native rules controls |
| `/prompts` opens the saved-prompt picker without sending | Missing | Native prompt picker |
| `/codex`, `/gemini`, `/opencode` open a fresh runtime draft on this repo, carry the body and require another Enter to send | Missing | Codex + configured OpenCode destinations; Gemini remains unavailable |
| `/chat` opens a fresh casual-chat destination with the body retained | Missing | See residual scope below |
| Intent row appears with nonempty draft, reads workspace targets, labels repo and base branch (main fallback) | Missing | Native Work on / off chips |
| Repository picker lists registry targets, selected treatment, path and empty state; choosing closes it without mutation | Partial | Workspace registry existed outside composer |
| Branch picker GETs `/api/panel/branches?path=...`, has loading/error/empty/search, current/worktree/commit metadata and recent-first sorting | Missing | Native branch picker |
| New branch form POSTs `/api/panel/branches` with name and current base; success selects/closes, error retains input | Missing | Native branch form |
| Repo and branch are advisory until send; they do not switch the checkout or send by themselves | Missing | Scope is included in next queue wire message |
| Repo/branch popovers are mutually exclusive and close on outside click or Escape | Missing | Native picker ownership |
| Active mode chip labels Solo / Shared / Worktrees, shows selected treatment and toggles a picker | Partial | Icon-only trigger and pointer picker existed |
| Mode picker changes this draft's mode, closes, retains runtime/model and affects the next real queue request | Present | Existing routing retained and exercised |
| Keyboard focus, Enter/Space selection and Escape/outside close restore focus; Up/Down move between modes | Partial | Buttons had Tab/Enter; arrow navigation was absent |
| Mode choice persists per conversation and survives reopening; no server mutation until send | Partial | In-memory draft overrides only |
| Quick actions open with Cmd/Ctrl+Shift+K outside textarea; search verb/label, Up/Down wrap, Enter picks, Escape/outside closes | Missing | Native shell and conversation key entry |
| Quick items: Prompts, Dispatch, Decompose, Fix, Review, Status, Clear; insert templates into editable draft without sending | Missing | Native quick actions |
| Saved prompts GET `/api/prompt-library` with available scope, repo, query and limit 100; nonempty search debounces 100 ms | Missing | Native prompt search with stale-result guard |
| Prompt picker has loading/error/empty states, keyboard/mouse selection and inserts at cursor/replaces selection, never sends | Missing | Native insertion test |
| Prompt selection records POST `/api/prompt-library/:id/use` without blocking insertion on failure | Missing | Existing use endpoint |
| Save prompt opens with title/tags/body and Global/Repository scope; POST `/api/prompt-library`, inline errors and duplicate/success receipt | Missing | Native save form |

The specifically named `IntentChips`, `ModeChip` and visual `ModePicker` modules
remain in classic source, but the first and both visual mode components have no
current production mounts. `ModePicker` still exports the legacy orchestration
preference helpers. The active composer uses `ComposerFleetChips`,
`composer-selector` and `composer-mode` (Solo/Shared/Worktrees), not the dormant
Fleet/Solo/Fusion and Fleet/Solo/Chat cards. This port follows the current active
mode vocabulary and restores the requested intent affordances. Native preference
files are separate from browser localStorage and are scoped to server + thread.

## Implementation and evidence

The editor owns autocomplete state, including dismissal, selection and the real
native input path. A separate cached 34 px toolbar scene changes on slash edits
or control state, while ordinary typing retains conversation and shell scenes.
The toolbar scrolls horizontally at narrow widths without a visible scrollbar.
It keeps the input and transcript geometry stable. Pickers use theme tokens;
menu entrance timing comes from `motion.rs`.

An explicit `/orchestrate` or `/fleet` applies Fleet routing to that turn without
changing the saved mode used by later sends. The command-route test reads this
from the real persisted queue payload.

Mode preferences and queued recall/compaction preludes persist as private native
JSON files, scoped to server and conversation. They do not import browser
localStorage. A confirmed queue receipt consumes only its frozen prelude, retaining context queued after an unconfirmed send. Repo/branch choices
remain transient advisory scope; selecting them never switches the checkout.
Refused requests retain their originating draft. No routes or dependencies were
added. The mic drawing and adjacent Live call match the baseline byte for byte,
recorded in [the preservation receipt](composer-controls/mic-preserved.json).

| Check | Result | Receipt |
|---|---|---|
| Same five real-composer acceptance tests on untouched rail base | 0 passed, 5 failed as expected | [Red tail](composer-controls/base-red.txt), [base receipt](composer-controls/base-receipt.json) |
| Final five real-composer acceptance tests | 5 passed | [Green tail](composer-controls/acceptance-green.txt) |
| Composer interaction, routing, persistence and retained-scene regressions | 34 passed | [Green tail](composer-controls/native-green.txt) |
| Final command route and refusal checks | 6 passed | [Green tail](composer-controls/commands-green.txt) |
| Final persisted mode, recall consumption and lost-response retry | 3 passed; retry regression separately failed before the fix | [Green tail](composer-controls/persistence-green.txt), [retry red](composer-controls/retry-red.txt), [retry green](composer-controls/retry-green.txt) |
| Native text input, including IME, RTL, selection, undo and 1 MiB clipboard | 11 passed | [Green tail](composer-controls/input-green.txt) |
| Node 22, packageManager npm, `npm run typecheck:fast` | Passed | [Typecheck](composer-controls/typecheck.txt) |
| Scoped ESLint and `rule-check` against the rail base | Passed | [ESLint](composer-controls/eslint.txt), [rule check](composer-controls/rule-check.txt) |
| Full `npm test` | 9,911 passed; 2 failed; 5 skipped | [Full failure tail](composer-controls/unit-failures.txt); existing [#4981](https://github.com/o8-run/o8/issues/4981), [#4989](https://github.com/o8-run/o8/issues/4989) |
| `npm run verify:ci` | Lint deadline and native selection failed; remaining run interrupted (exit 130); Security Audit passed | [Check transcript](composer-controls/verify-ci.txt), [summary](composer-controls/verify-ci.json); diagnostic finding [#5137](https://github.com/o8-run/o8/issues/5137) |

The Linux verification overlay [matches all 23 changed source files](composer-controls/ci-source-match.json) in source commit `1a03c30ea`. The isolated native selector returned `changed=true` in 12.25 seconds after the full verifier rejected selection. That separate result does not satisfy the skipped native gate.

The full verifier was stopped after its failed gates, before repeating the hermetic shards. In-flight type checking, classification, bundle and integration checks were interrupted; Governance Smoke was not reached. Their interruption results are not separate established defects. This run does not provide full CI or Linux native acceptance.

The two broad unit failures are in [unchanged baseline test files](composer-controls/unit-baseline-files.json). A [focused recheck](composer-controls/unit-recheck.txt) passed the Activity file and reproduced two redaction timing caps. This does not establish a new root cause for either existing issue.

The loaded image composer passed its unchanged 60 Hz CPU-scene assertion:
p50 **12.345761 ms**, p95 **15.959669 ms**, under the 16.667 ms bound. The run
retains shell chrome and transcript scenes. These are debug headless CPU scene
measurements, not GPU, compositor or physical input latency measurements.

Build and test commands use `nice -n 19`. Rust formatting is per file with
`skip_children=true`; the baseline mic block is preserved instead of accepting
formatting churn in another surface's owned control.

The required acceptance command, run with the same test module on base and branch,
was:

```sh
nice -n 19 cargo +1.97.1 test --locked \
  --manifest-path native/o8-next/Cargo.toml --bin o8-next \
  prompt_acceptance_tests::native_composer_controls -- --test-threads=1
```

The broader native run used the `native_composer` filter; final command and
persistence receipts use `prompt_tests::native_composer_controls` and
`prompt_persistence_tests`. Each uses the same production surface and disposable
server fixture, not a helper-only simulation.

## Native captures

| Appearance | Slash menu open | Mode picker open |
|---|---|---|
| Light | [Slash](composer-controls/light-slash.png) | [Mode](composer-controls/light-mode.png) |
| Dark | [Slash](composer-controls/dark-slash.png) | [Mode](composer-controls/dark-mode.png) |
| Glass | [Slash](composer-controls/glass-slash.png) | [Mode](composer-controls/glass-mode.png) |

[Capture hashes and scope](composer-controls/captures.json) accompany the six images.

The owned native fixture uses the production composer with GPUI text-input and
button-key dispatch. It requests a full native redraw before each snapshot so
capture does not depend only on inactive-window damage tracking. Interaction and
latency tests are separate. Repeated captures still exposed missing cached sibling
text and footer content, including the glass mode frame above. This is tracked in
[#5138](https://github.com/o8-run/o8/issues/5138); baseline presence and root cause
are unverified. These images establish the open menu states, not complete native
rendering acceptance. The glass captures use the native glass theme in the
standalone fixture; they do not establish the installed shell's backdrop material.
No operator server, provider session or installed application was used.

## Residual and decision

The control port is reviewable, but destination parity is partial. `/chat` and
`/gemini` are listed, insert their command prefixes, and then explain that their
native destination is unavailable, retaining the exact draft. Gemini is a worker
runtime, not a valid orchestrator backend. No invalid backend is persisted and no
message is sent to a different runtime as a substitute. Completing those two
paths needs native destination surfaces. OpenCode needs a configured model before
a new native draft can be confirmed.

`/ask` streams through the existing native Brain reading panel using the same
`/api/cortex/ask` route. It does not create the classic inline command-answer card.
Other thread commands reuse the classic endpoints; provider-backed compaction
and Brain generation were not exercised against an operator runtime. Rules,
prompt use/save, branch creation, queue sends and registered runtime draft
creation were exercised through production handlers in disposable fixtures.

Draft [PR #5139](https://github.com/o8-run/o8/pull/5139) is held for review, missing destination surfaces, the rendering finding and a clean broad verification run. No merge, release,
installation or full destination-parity acceptance is implied.
