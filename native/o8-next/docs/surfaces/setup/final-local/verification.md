# Final local verification

Rebased on `417586b6b00e55f4759fc95a68091ffad7596213`. The native implementation
changes only setup source files and the shell's one setup inventory line.
Shared client, registry, main entry, shell view/state/tests and dev host match main.

## Model resolution

Native matrix: `src/surfaces/setup/final_tests.rs`, included from `tests.rs`.
The [matrix](matrix.md) was written before the model correction. It covers Claude,
Codex, OpenCode, Pi and Pi's API-key provider/model form, each with and without a
saved default. Two additional cases keep managed o8 routing independent of an
unrelated saved Claude preference. Every native case checks persisted conversation
routing and its first production queue entry through GPUI controls and production
defaults, history and queue handlers. Discovery is the authored boundary.

[Native red](model-red.txt): six passed, six failed. All Claude/Codex/OpenCode
cases passed; all Pi, API-key and managed-o8 cases failed on missing resolution.
The shared recommendation [red](recommendation-red.txt) reported four failures
among 21 cases. The later [provider-form red](pi-provider-red.txt) reproduced a
missing `openrouter/` routing prefix: one failure among 23 cases.

Claude retains its saved or canonical model. Codex honors its validated local
lead default, independently of Claude preferences and worker defaults. OpenCode
keeps its saved/configured/canonical precedence. Pi uses its detected model and
preserves an explicit OpenRouter route. When a model is unresolved, the native
tools page asks for its ID before creating a conversation. The managed o8 model
comes from its existing canonical resolver. No runtime default ID is copied
into the native implementation. This is queue/routing proof, not live inference.

The richer recommendation also reaches desktop setup. Its save helper now keeps
read-only runtime model metadata out of operator model-default writes. Explicit
configuration validation is unchanged. The [desktop-save red](desktop-save-red.txt)
reported two failures and eight passes before this compatibility correction.

Final [native green](rebased-native-green.txt): 22 passed, including all 12 model-matrix cases. Related TypeScript
batch: seven files, 57 tests passed, including all 23 recommendation cases.

## Registration and lifecycle

The [red compiler output](registration-red.txt) comes from applying the old setup
files plus its one inventory entry to main. The native binary failed with E0560
for `loaded` and `allow_open`; its test target also rejected those absent fields.

The correction uses only the existing navigation, key and overlay hooks. Setup's
runtime owns a once-per-shell check, deferred after connection. Closing setup
keeps that check complete for the shell lifetime. Per-frame view mouse capture
and the module's key hook preserve busy navigation refusal.

The compiler probe archives main's native source, fixtures, locked manifest and
the unchanged CSS fixture. It overlays only `src/surfaces/setup.rs`,
`src/surfaces/setup/**` and the one shell entry. The temporary manifest only
relocates the immutable vendor path. All 100 original main native source files
match byte for byte after removing the inventory line; the setup files match
the final tested source. The [green proof](rebased-registration-green.txt) runs
`cargo check --locked --offline --all-targets` both with and without that entry.
Both exit zero, including unchanged surfaces and their test constructors.

The [busy-input probe](lifecycle-green.txt) holds the view's in-flight state
because GPUI's public input helper drains blocking HTTP tasks before returning.
It drives actual mouse and keyboard dispatch with 100 tool rows, rejects
navigation while busy, permits it after release, and keeps setup closed after
Retry. No layout change was needed for the tall-tools case. Actual saves run
through production routes in the other setup cases. Prior setup names remain.

## Completion checks

The fresh full run on `417586b6b` remains **red: 150 passed, 4 failed, 3 ignored**. Diff paint, pane-grid fixture startup and the terminal flood passed their isolated reruns without source changes. All seven CLI integrations passed separately. Main's unchanged Activity test at `native/o8-next/src/surfaces/activity/tests.rs:27` still expects Diff immediately after Activity, but the merged PR command now sits between them (`Open pull requests` versus `Open diff for a packet`). Setup adds no palette command, and that test is unchanged from main. Its assertion needs to permit other registered commands. The broad failure is retained; the passing reruns do not replace it.

Before that main integration, the full serial run on `160576643e` passed **126 unit tests, zero failed, three ignored**, plus all seven CLI cases. Both receipts remain in the per-surface docs.

[Fresh full red](rebased-native-full-red.txt), [isolated reruns and CLI green](rebased-reruns-green.txt), [earlier serial green](native-full-green.txt), [final gates](rebased-gates.json).

- `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast`: passed.
- Related TypeScript: seven files / 57 tests passed; no full npm suite in this round.
- Clippy `--all-targets`: exit zero, no setup diagnostics. Existing warnings elsewhere remain.
- Rust formatting and scoped ESLint: passed.
- Rule check: three files, zero violations.
- Classification: 1,238 hermetic / 910 resource-owning; all 78 date-fixture checks pass.

The owned `native/o8-next/target/final-4660` was removed after the final Cargo jobs completed; absence was verified. The 4655 and 4652 worktrees were left alone.

macOS headless checks only. No OS-level input, installed-app operation, merge,
closure, release or version change. Earlier receipts remain under their original
conditions. The parent parity inventory retains the partial-port limits.
