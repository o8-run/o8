# Chat panel fix round 1

Reviewed head: `393d4797d9b9b6b8c91f4aa39308eb472a93b403`.

## Tool rollup categories

`activity::tests::rollup_matches_all_desktop_corpus_categories` in
`src/activity.rs` runs every row of the reviewer's 56-case corpus through the
native tool parser and collapsed summary. `fixtures/rollup-desktop.json` records
those inputs and their desktop strings from `classifyTool` and
`describeToolRollupParts` in `ToolCallChipCluster.tsx`, using `classifyToolCall` in
the desktop orchestrator's `ToolCallChip.tsx`.

Red on the reviewed head, with only the test and corpus added:

```text
28/56 desktop rollup mismatches:
test activity::tests::rollup_matches_all_desktop_corpus_categories ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

The fix stores the desktop tool kind independently of the executable grouping
key. Native reads, spec and Brain calls count as exploration; shell tools count
as commands even when their command reads a file; delegation and writes use
their own counts; generic calls remain tool calls. Namespaces, the desktop's
classification precedence, and its shell `o8 ask` exception are preserved.
Running-step labels, failure counts and expanded executable grouping are unchanged.

Green, with all 56 expected strings matching:

```text
test activity::tests::rollup_matches_all_desktop_corpus_categories ... ok
test result: ok. 1 passed; 0 failed; 0 ignored
```

## User rich backdrops

`retained::geometry_tests::user_rich_backdrops_stay_inside_bubble_and_reading_column`
in `src/retained/geometry_tests.rs` adapts the reviewer's geometry probe into a
real retained-row render at 1680 by 1050. It inspects the cached geometry actually
used by paint, requires the 768 px reading column, and checks fenced code, media
and rules against both their user bubble and the column.

Red on the reviewed head in both dark and light:

```text
fenced code: column_width=768 backdrop_right=1175.3999
fenced code: user rich backdrop escapes the reading column: 1175.3999px > 768px
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

The user-bubble helper now sizes rich backgrounds to the measured inner bubble
before applying the rightward translation. Text placement, the bubble itself and
theme colors remain unchanged. The bubble helper and unchanged text-style helper
live in `src/retained/user_bubble.rs` and `src/retained/text.rs`, keeping
`retained.rs` below the file-size limit.

Green in both dark and light, including all three rich-node cases:

```text
fenced code: column_width=768 backdrop_right=744
rule: column_width=768 backdrop_right=744
media: column_width=768 backdrop_right=744
test retained::geometry_tests::user_rich_backdrops_stay_inside_bubble_and_reading_column ... ok
test result: ok. 1 passed; 0 failed; 0 ignored
```

## Test integrity and completion checks

The PR's own new `settled_tool_runs_collapse_to_a_counted_line_and_expand_on_click`
test now expects the desktop's `Ran 4 commands` for four exec calls, including the
three shell reads. Its source fixture is unchanged. Assertions and inputs of tests
already on main are preserved. Rustfmt also corrects pre-existing wrapping in
`shell_rail.rs`, `shell_view.rs`, `startup_tests.rs`, `surface_tests.rs` and
`visualization_tests.rs`.

Focused groups: activity 20 passed; retained 4 passed; UI 40 passed and 2 ignored;
visualization 4 passed. No focused-group failures. Both geometry appearances,
Cargo fmt and fast TypeScript checking passed.

The first full native run used the inherited home-directory TMPDIR. Every test
identity was accounted for: **355 passed, 4 failed, 8 ignored**. Fixed-rate PTY
probes ran alone; the regular cohort used four threads. The failures were:

- `diff_tests::diff_real_server_selection_modes_review_and_virtualized_paint`:
  unsupported-document assertion.
- `pane_grid::tests::terminals::real_slot_terminals_route_keys_retain_hidden_attachments_and_restart`:
  fixture origin was unavailable.
- `shell::sidebar::tests::sidebar_worker_archive_real_path`:
  workspace-selection refusal with a home-abbreviated fixture path.
- `shell::workers::review_tests::workers_restart_outcome_unknown_retry_keeps_one_steer`:
  recorded response status was null rather than 409.

Using the normal Linux CI fixture temp directory (`/tmp`), diff, grid-terminal and
archive each passed alone. Archive still failed alone with the inherited home
TMPDIR and passed alone with `/tmp`, without any code change. The worktree and
the single Cargo target remain under the home directory in both configurations.

The worker restart case still failed alone with `/tmp`. A separate control
compiled the original tracked Rust sources at `393d4797d` in the same checkout
and reproduced the identical null-versus-409 failure (0 passed, 1 failed). All
owned edits were then restored and checked by content hashes, the fixed source
was rebuilt, and its confirmation rerun reproduced the same failure (0 passed,
1 failed). No worker implementation, test assertion or input was changed.

These controls do not erase the original full-run failures or claim a green
local native suite.


The required `npm run verify:ci` replay completed with the normal Linux fixture
temp directory. Its native matrix recorded **352 passed, 1 failed, 8 ignored**;
the worker restart failure above was the only failure. Six CLI cases were not
reached in that replay because Cargo stopped their shard after its unit failure;
all six passed in the first exhaustive run. The diff, grid-terminal and archive
cases all passed in this replay's cohorts.

The hermetic JavaScript matrix recorded **9,860 passed, 4 failed, 5 skipped**.
The four failures were in unchanged files:

- `src/lib/acp/output-redaction.generated.test.ts`: repeated-base64 wall-time
  budget and mixed-escape CPU-time budget.
- `src/components/desktop/transcript/TranscriptTurns.test.tsx`: the 5,000-message
  prompt navigation test exceeded its timeout.
- `src/components/desktop/O8ActivityPane.retention.test.ts`: the commits retry
  case still observed the previous pull-request title.

Each of these four cases then passed alone, with its original budgets, timeout,
inputs and assertions unchanged (**4 passed, 0 failed**). Lint, security audit,
test classification, changed-file integration checks, server bundle size,
TypeScript checking and governance smoke all passed in the replay. The verifier
exited 1 because the original matrix failures remain failures; isolated reruns
are additional evidence rather than a replacement for those results.
