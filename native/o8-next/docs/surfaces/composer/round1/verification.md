# Composer review round 1

Rebased onto `origin/main` at `0eeb65889d41c45dbdc5664d85b7d54d1faf6eef`.
The existing PR branch is retained. This round fixes Send focus and supplies the
tested composer-side port for the focused-keymap integration in #4718.

## Send focus

The real pointer Send control saved and cleared the message while retaining its
button focus. The failing test checks the persisted queue, cleared editor and
focus handle before attempting to type the next draft. It also activates Send
with Enter from the button's own focus handle.

Send now returns focus to the originating editor in the activation callback.
This happens before the asynchronous response, so a late response cannot take
focus back after the user changes sessions or controls.

```text
RED: successful pointer Send must return focus to the editor
test result: FAILED. 0 passed; 1 failed
GREEN: native_composer_review_send_button_returns_focus_to_editor
test result: ok. 1 passed; 0 failed
```

## Focused-keymap composition

The explicit peer revision is `a7f9dfc2f167216f93f1fa4288985056b2f4e793`.
It remains an independent open PR. The probe creates an owned temporary worktree
at that revision and overlays the composer files from this branch. Temporary
paths are canonicalized and the worktree is removed after the command.

Taking the peer's edit handler and render hook first failed to compile because
the card inherited `KeyDownEvent` through an import the peer removed. Adding the
card's direct import then reproduced the behavioral finding: word movement
advanced one character, producing UTF-16 caret `24..24` instead of `21..21`.

`Composer::edit_key` now holds the single editing implementation. The ordinary
key-event hook delegates to it. `composer/keymap.rs` supplies the focused-action
adapter, which also delegates to it rather than replacing word navigation,
undo grouping, clipboard guards or IME behavior. The input publishes its
`TextInput` context explicitly.

To compose the two PRs, the probe activates that adapter and the peer's action
listener, installs the actual keymap, and ports WordLeft / WordRight /
WordBackspace / WordDelete into its canonical binding table. Option variants
and redo aliases remain represented in that table and its generated reference.
The adapter is compiled in this composed checkout; its peer action registry is
not present on current main. These port steps are explicit in
`check_composition.py`, rather than a replacement test implementation.

```text
RED: native_review_word_dispatch_survives_focus_and_unicode
left: 24..24
right: 21..21
test result: FAILED. 0 passed; 1 failed

GREEN rebased composer: 24 passed; 0 failed
GREEN composed composer: 26 passed; 0 failed
GREEN composed keymap: 16 passed; 0 failed; 1 ignored
keymap focus matrix: 6496 dispatch cases
```

The ignored keymap case is its opt-in performance measurement. All dispatch,
reference, focus protection and hidden-shell regression cases pass. The new
word test refocuses the field, moves and selects words after emoji and a newline,
then deletes and undoes through GPUI dispatch. The complete composer checks also
retain mouse/keyboard selection, line movement, undo/redo, both 1 MiB paste
shapes, composition, Return/Shift+Return, Unicode bounds and draft isolation.

Reproduce the behavioral failure by adding `--unported` and selecting
`--test native_review_word_dispatch`. Run the fixed integration with:

```sh
python3 native/o8-next/docs/surfaces/composer/round1/check_composition.py \
  --peer-ref a7f9dfc2f167216f93f1fa4288985056b2f4e793 --test composer
python3 native/o8-next/docs/surfaces/composer/round1/check_composition.py \
  --peer-ref a7f9dfc2f167216f93f1fa4288985056b2f4e793 --test keymap
```

## Gates and residual

- `npm run typecheck:fast` and
  `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed.
- `npm run test:classify`: passed, 1238 hermetic / 911 resource-owning files.
- Touched-file ESLint and rule-check: passed. Rust and Python have no applicable
  ESLint rules; the full PR's one TypeScript fixture has zero rule violations.
- Full `npm test`: 9074 passed / 5 skipped, 1242 passing / 3 skipped files.
- Rust formatting and Python syntax checks: passed.

The PR carries `shell-work`: this reusable native input serves multiple existing
surfaces, so its context and dispatch contract are shared work under the new
boundary checker. No additional screen or peer shell implementation is ported
into this branch, and no release, version, deployment or publishing file changes.

The reviewer measured macOS debug first CPU-scene p50 at 9.91 ms and standalone
editor p50 at 0.797 ms. The macOS first-scene target below 2 ms remains unmet;
this round establishes the two behavioral fixes and their composition, without
new macOS timing. A new Linux debug standalone run measured p50 0.543076 ms /
p95 0.639310 ms over 100 input-to-CPU-paint samples. That is the standalone
endpoint, not the full composer card's first scene. The earlier model-catalogue, microphone and native visual
verification residuals remain. The PR continues to use `Refs #4712`.
