# Image remove chips: one activation per full key press

Reviewed head: `fed169dac5e9167cffdf359d6d65be06e9944b3d`.
Implementation tested: `2a99cfedcfcfcb0bf0d426a965702d0373843b44`.

## Mechanic

The chip removed an image on KeyDown, then GPUI synthesized a keyboard ClickEvent
on KeyUp. Focus had already moved to the next image in the same slot, so release
removed that image too. Keyboard removal now has one activation path: the existing
KeyDown handler. The click handler accepts only Mouse events and ignores the
synthetic Keyboard click. Pointer activation, Tab stops and focus restoration
remain intact. No vendor, route, auth or image-delivery code changed.

## Red and green

The new tests append to `src/composer/image_tests.rs` and drive actual clipboard
paste, Tab navigation and GPUI platform events. Each starts with three images,
focuses the middle chip, sends KeyDown, draws a frame, then sends KeyUp. The frame
allows the following image to occupy the removed chip's slot before release.

- `native_image_remove_full_enter_press_once`
- `native_image_remove_full_space_press_once`

On the reviewed head plus tests only (`fc87cccf3`), both failed: **0/2/0**
passed/failed/ignored. Both red tails show:

```text
one full enter press must remove exactly one image
left: 1
right: 2

one full space press must remove exactly one image
left: 1
right: 2
```

On the fix, both pass: **2/0/0**. Each also checks a second full press,
next-chip then input focus, unchanged draft text and an empty send queue.
The original restore-focus test and every other existing image test remain
byte-for-byte unchanged; only the new tests were appended. This round changes no
main test assertions or inputs.

## Verification

Linux debug GPUI test platform, Node 22.23.3, npm 11.21.1, nice 10, Cargo -j 4,
debug information disabled and incremental compilation off. Checkout and target
were under home. No release build was used.

| Check | Passed/failed/ignored |
| --- | --- |
| Composer group | 39/0/0 |
| Image group | 9/0/0 |
| Full native suite once, --test-threads=4 | 336/1/8 |

The full sweep includes the integration binaries and uses a debug-built HTTP
fixture daemon. Cargo check --locked --all-targets and npm run typecheck:fast passed.

Failures from the requested runs were selected alone on head and the test-only
predecessor (`fc87cccf3`, reviewed code plus the same new tests):

| Test | Head | Before fix |
| --- | --- | --- |
| `shell::sidebar::tests::sidebar_worker_archive_real_path` | 0/1/0 | 0/1/0 |

Worker archive failed on both revisions with `Select a workspace before changing
this session.` These isolated reruns do not turn the recorded full sweep into a
passing run.

The extra npm hermetic unit gate could not collect tests. Its first startup
failed creating an experimental cache temporary file; creating the missing cache
directory exposed a Vitest startup `TypeError: code.charCodeAt is not a function`.
No application source or configuration workaround was applied. An additional
verify:ci sweep was not run on top of the requested single full native sweep.

Auto-merge was checked and left disabled. No merge or release was performed.
