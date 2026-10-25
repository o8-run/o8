# Keyboard shortcuts

The reference and its bindings register through `src/surfaces/shortcuts.rs`.
The original modal focus, dismissal, clipboard-free reference and tab navigation
remain scoped to the opt-in shell. See [parity and prior evidence](shortcuts/verification.md).

Neither new review finding was fixed at the previous pushed head. The earlier
Enter-to-close and composer-focus fixes remain covered by the original test.

Editable controls now advertise the `o8-editable` key context. The surface reads
the focused context to keep `?` and close chords with the terminal/text editor.
The optional registry `pass_key` hook preserves propagation to the editor rather
than running the shell's Ctrl+W handler. Ctrl+Alt+Left/Right remain owned by Grid;
Cmd+Alt+Left/Right continue to cycle shell tabs.

The dialog renders as an anchored, deferred window layer owned by this module.
Its focus loop, dismissal and return focus stay intact without changes to the
shared shell view. [Red](shortcuts/registration/red-tail.txt) reproduced all three
new regressions (including a real PTY); [green](shortcuts/registration/green-tail.txt)
passes those and the original overlay case. The owned PTY fixture uses graceful
shutdown, matching the existing test host.

The extraction also preserves the existing list scroll position across reopen;
the new [scroll red](shortcuts/registration/scroll-red-tail.txt) caught a reset
to zero, and [final green](shortcuts/registration/green-final-tail.txt) passes
all five surface cases after moving that handle into `Runtime`.

Outside the surface files and inventory line: `src/composer.rs` and
`src/terminal.rs` add one editable-context line each; `src/surface_registry.rs`
and `src/shell.rs` add the generic key-propagation hook. Main's view/state/tests,
client and dev-host dispatcher remain unchanged. All
[main and original surface test names](shortcuts/registration/preserved-tests.json)
are preserved. Three pre-existing Clippy suggestions remain in unchanged parts
of the shared composer/terminal files; the new surface code has none.

Current rebase results, failures and retries: [shortcuts/registration/verification.md](shortcuts/registration/verification.md).

Refs #4548
