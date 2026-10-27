# Correction round 2

Only PR #4670 was updated, rebased on `3b99b20d6`. All 99 main native test
function names and five previous shortcut cases are retained. See
[inventory](preserved-tests.json).

The shared `pass_key` extension and editor key-context additions are removed.
The complete product change is the shortcuts module and its files plus one
inventory line in `shell.rs`. A standalone probe compiles an archive of main
with only those additions; composer, terminal and registry bytes stay identical
to main. Run:

```sh
python3 native/o8-next/src/surfaces/shortcuts/registration_probe.py --base 3b99b20d6
```

The [red probe](registration-red.txt) fails with `E0560: pass_key`. The [green probe](registration-green.txt) compiles successfully with only
those additions. [Scope](scope.json) records the shared-file identity check.

Input ownership now uses public GPUI entity observers and weak focus handles
for the three native input types: Composer, Secret and terminal Pane. It reads
no credential contents and requires no modifications to those types. The module
uses the terminal's existing input API for keys claimed by shell capture.

Tests were written before the fixes. [Field red](input-red.txt) reproduces help,
close, numbered-tab and directional-tab actions from a focused Settings API-key
field. [PTY red](ctrl-k-red.txt) reproduces Ctrl+K opening the palette. An owned
raw peer reports actual stdin bytes over the production PTY/WebSocket path.
[Settings chord red](pty-settings-red.txt) catches the same focus steal through
Settings. The final byte checks cover Ctrl+K `0b`, Ctrl+W `17`, Tab `09` and
BackTab `1b5b5a`.

The final field matrix protects 27 bindings and checks six explicit pass-through
chords: Cmd/Ctrl+K, Cmd/Ctrl+comma and Ctrl+Tab/Shift+Tab. The first matrix treated
Ctrl+Tab as blocked; main's unchanged restart test established its pass-through
contract. The added [pass-through regression](pass-through-red.txt) failed
before narrowing the guard. The corrected module preserves that existing
behavior for text fields while PTYs retain terminal Tab bytes.

Native tests live in `src/surfaces/shortcuts/tests.rs`, `review_tests.rs` and
`correction_2_tests.rs`. They drive the real shell, Settings controls, focused
credential editor and production terminal fixtures. The restored Brain field
case checks input creation during the first frame. All ten shortcut cases pass. The [final focused run](final-focused-green.txt)
passes **12 cases**, including main's restart and standalone diff regressions.

The existing TypeScript entry tests passed **2 files / 7 tests**:
`tests/next-surface-registration-real-path.test.ts` and
`tests/o8-next-shell-real-path.test.ts`. See [receipt](typescript-green.txt).
No TypeScript file was changed.

Full `npm test -- --experimental.fsModuleCache=false --maxWorkers=2` passed
**1,242 files / 9,057 tests**, with **3 skipped files / 5 skipped tests**.
See [receipt](npm-full.txt).

Final full native run: **97 unit + 7 CLI cases = 104 passed**, with **3 existing
ignored measurements**; see [final result](native-final.txt). The [initial broad
run](native-initial.txt) reported **95 passed, 2 failed, 3 ignored**. Its Ctrl+Tab
failure exposed the overbroad guard, which was narrowed in the shortcuts module.
The unchanged standalone diff paint case passed focused retry and the final full
run. No main test or diff source was changed.

Both 8 GB TypeScript checks, ESLint, rule-check, classification and Clippy passed;
see [gates](gates.json) and [Clippy](clippy.json). Clippy reports no diagnostics in
touched Rust files. ESLint ignores seven Rust files; Clippy checks them.

The final focused run measured **11.62 ms open-to-first-frame** and **19.76 ms
interaction-to-frame**; see [timing](run.json). Linux debug CPU scenes establish no macOS,
GPU/compositor or physical-input latency claim. Missing bindings in the parity
inventory and those unmeasured platforms keep #4548 open.

Refs #4548
