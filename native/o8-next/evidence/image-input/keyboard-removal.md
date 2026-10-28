# Composer image removal: keyboard correction

Reviewed head: `b0225f904`. Main comparison: `4afce63db`.
Repair source: `86c1d1404`, after merging main at `f27260339`.

## Mechanic

The image remove div had only a click callback. The composer card also returned Tab from the message input to the reading surface, bypassing attachments. Keyboard users could not reach or activate a pasted image's remove control.

## Change

- Follow the existing composer button pattern: persistent focus handles, Tab stops, visible focus, mouse focus, and Enter/Space activation. Externally tracked GPUI handles carry `tab_stop(true)` themselves.
- When images exist, Tab from the message input reaches the first remove button. Normal forward/reverse Tab traversal reaches the other buttons.
- Removing an image focuses the next chip in the same slot. If no next chip exists, focus returns to the message input. Draft text is preserved, and removal cannot submit it.
- Retire obsolete remove focus handles after removal or a confirmed send. Image payloads, delivery behavior (#4979), and #4974 remain untouched by this repair.

## Red and green

`ui::conversation::card_tests::image_tests::native_image_remove_chips_tab_enter_space_restore_focus`

On reviewed source plus the new test, before implementation:

```text
Tab from the editor must reach the first image remove button
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

After the repair, the same test passes: **1 passed / 0 failed / 0 ignored**. It pastes three images, tabs forward to every remove button and backward to the middle one, removes with Enter then Space, checks next-chip/input focus, removes the final image, and verifies the draft and empty queue.

The regression's input sequence and assertions are identical between red and green (formatting only). Main's existing card test text remains identical after removing the added image test module declaration; no main assertions or inputs changed.

## Verification

Locked dependencies, Node 22 and declared npm 11.21.1, debug builds with debug information and incremental compilation disabled, nice priority 10 and four Cargo jobs. Focused groups and the full native run use four test threads; the full run includes the six integration targets. The HTTP fixture daemon uses a debug build with `experimental-http`.

| Run | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Composer group | 39 | 0 | 0 |
| Image group | 5 | 0 | 0 |
| Full head, once | 332 | 3 | 8 |
| Failing cases isolated on head | 2 | 1 | 0 |
| Same cases isolated on main | 2 | 1 | 0 |

`cargo check --locked --all-targets` and `npm run typecheck:fast`: pass.

Every full-sweep failure was rerun alone on each revision:

| Test | Full head | Head alone | Main alone |
| --- | --- | --- | --- |
| `shell::sidebar::tests::sidebar_worker_archive_real_path` | failed | 0/1/0 | 0/1/0 |
| `terminal::tests::production_pty_flood_waits_for_delayed_tail` | failed | 1/0/0 | 1/0/0 |
| `terminal::tests::production_pty_to_gpui_terminal` | failed | 1/0/0 | 1/0/0 |

The worker archive test reports the same notice on both revisions: `Select a workspace before changing this session.` Both PTY probes passed alone on both revisions after their failures in the concurrent head sweep. The full head run is not green; no assertion, input, ignore state, byte count, or time bound was changed to accommodate these failures. Main was used for isolated comparisons; it was not given another full sweep.

The npm unit gate also fails to collect tests on main with the same Vitest startup error as head.

The npm unit gate could not collect tests: Vitest raised `TypeError: code.charCodeAt is not a function` during startup. No test/configuration workaround was applied. Local verify:ci was not run in addition to the requested single full native sweep; hosted CI remains necessary.
