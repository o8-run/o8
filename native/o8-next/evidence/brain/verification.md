# Brain parity and verification

The installed app is unchanged. Brain is reachable only inside the existing
opt-in native client. The source surface is `src/components/desktop/brain`.

## Desktop parity

| Desktop control or behavior | Native counterpart | Status |
| --- | --- | --- |
| Open Brain dock tab | Open Brain beside the selected session; shell Open Brain command | Ported |
| Disabled without a repository | Launcher and submit refuse unscoped sessions | Ported |
| Ctrl+E / Cmd+E | Session dock and Brain keyboard handlers | Ported |
| Minimize Brain / Escape | Minimize, retain conversation, return composer focus | Ported |
| Message Brain textarea; Enter / Shift+Enter; IME | Shared native Composer, including Unicode, paste, selection and undo | Ported |
| Send to Brain; empty and busy refusals | Authenticated POST `/api/cortex/ask`; trim and busy guards | Ported |
| Read/search project memory | Same server retrieval through questions; native local conversation/source find | Ported |
| Conversation log, Markdown, scroll and follow | Existing retained Markdown rows and GPUI list | Ported |
| Answer-source title and excerpt tooltip | Source chip and click-to-read excerpt | Ported |
| Empty, thinking, reading-source and error states | Same copy and source counts; partial answers retained on error | Ported |
| Runtime/model hint | Existing SSE route label, including managed fallback | Ported |
| Clear conversation | Cancel view delivery, clear local messages/errors, reject late generations | Ported |
| Scope/deactivation and retained drafts | Separate entities by session/workspace; session switches minimize the dock | Ported |
| PR-detail prompt/context handoff event | Native PR-detail integration | Missing |

The last row requires a native PR-detail surface; no web event bridge or account
integration is added. Workspace context is wrapped with the same source-data
instruction and bounded recent history. Questions go through the same production
route; the native surface adds no directive mutation, deletion or approval route.

## Red first

- [Shell red](red-shell.txt): the real command palette left `Session` selected
  instead of opening `Brain` (0 passed, 1 failed).
- [Action red](red-actions.txt): loading and successful answers failed against the
  fixture before native streaming delivery and fixture wiring (0 passed, 2 failed).
- [Dock red](red-dock.txt): minimizing failed to return keyboard focus
  (0 passed, 1 failed).
- [HTTP red](red-http.txt): the route host returned 404 instead of the existing
  401 authorization refusal and 400 validation response (2 failed).

The tests were authored before the corresponding fixes. No expected snapshots
were regenerated to hide failures.

## Green and coverage

The four new headless GPUI tests are in `src/brain_tests.rs` and
`src/brain_dock_tests.rs`. They drive shell commands, native text input, actual
buttons, search, source disclosure, minimize/reopen, session switching and HTTP
answers. They inspect persisted request payloads and shell state, canonicalize
repository paths, and prove that clearing a slow answer cannot repopulate a new
conversation. The source count is painted before the slow fixture answer ends.
The shared editor's existing IME and Unicode tests run in the native suite.
All six shared-shell tests, including Brain and Inbox palette entry points, pass
on the reconciled main base; see [shell integration](green-shell-integration.txt).

`tests/next-brain-real-path.test.ts` drives the real production Brain route and
operator middleware. Retrieval reads an authored indexed directive; citation
translation is production code. The fixture replaces runtime resolution and the
runtime call, asserts the production read-only contract, and refuses external
fetches. Invalid/missing credentials, empty questions, successful sources and
sanitized runtime failures are covered without an account.

Before/after: 0 to 2 native Brain entry points; 0 to 4 passing native Brain tests;
0 to 2 passing production-route Brain tests. The 7 related route/parity files
passed all 24 tests. See [native action green](green-actions.txt),
[dock green](green-dock.txt) and [HTTP green](green-http.txt).

The locked dependency graphs audit 472 Linux packages and 455 macOS packages with
zero GPL or excluded application crates. The only added direct dependency,
`async-channel = 2.5.0`, was already in the locked graph and is Apache-2.0 OR MIT.
See [license audit summary](licenses.json).

## Reproduce

Use Node 22 and Rust stable, the repository's installed dependencies and the
normal GPUI Linux linker prerequisites. The full native suite also needs the
existing daemon fixture binary:

```sh
cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http --bin o8d
cargo test --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=1
npx vitest run tests/next-brain-real-path.test.ts tests/o8-next-shell-real-path.test.ts tests/next-diff-review-real-path.test.ts tests/next-history-real-path.test.ts tests/next-stream-parity.test.ts tests/next-render-parity.test.ts tests/next-terminal-real-path.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npm run typecheck:fast
npx eslint scripts/next/dev-server.ts scripts/next/brain-fixture.ts scripts/next/brain-runtime.cjs tests/next-brain-real-path.test.ts
npm run test:classify
npm run rule-check -- --base=origin/main
npm test
```

The harnesses own temporary data and fixture processes. They do not stage native
files from another platform or access an installed app. No release, version,
deployment or publishing inputs changed.

## Fixture measurements

Three Linux debug runs, collected after the completion gates, use GPUI TestAppContext and its test text system. Open
includes opening/filtering the real shell palette and the first Brain scene.
Input p95 uses 20 dispatched editor inputs per run. Ask includes authenticated
HTTP, real source retrieval, the fixture runtime response, and answer paint.
Clear ends after the cleared scene paints. Every input acknowledges the editor's
revision in its paint callback, and answer rows must reach their paint callbacks.
The fixture server and saved session reads are ready before the open timer starts.

| Run | Open to first Brain frame (ms) | Input to frame p95 (ms) | Ask to answer frame (ms) | Clear to frame (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 43.93 | 7.87 | 166.06 | 16.07 |
| 2 | 45.24 | 7.91 | 168.75 | 16.83 |
| 3 | 45.19 | 7.94 | 168.66 | 15.72 |

Raw receipts: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json).
Before the change Brain had no native entry point, so latency has no numeric
before baseline. These are CPU scene measurements, without native font shaping,
GPU work, compositor presentation or physical input latency. No macOS timing or
on-screen visual acceptance is claimed.

## Completion gates

TypeScript (`npx tsc --noEmit` with 8 GiB heap and `typecheck:fast`), ESLint on
all touched JavaScript/TypeScript, test classification, Rust formatting and the
rule check against the current main base passed. The rule check scanned both
changed non-test TypeScript files, rather than accepting an unresolved base.

```text
test result: ok. 40 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 407.40s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
Test Files  1233 passed | 3 skipped (1236)
      Tests  8896 passed | 5 skipped (8901)
   Duration  479.15s (transform 29.13s, setup 45.13s, import 594.01s, tests 549.49s, environment 457.29s)
```

Three explicitly opt-in native measurement workloads remain ignored by the
ordinary native suite; Brain's own measurements above run without an ignore flag.
The existing daemon fixture binary was built before the complete native rerun.

Residual: PR-detail prompt/context handoff remains missing, so the PR references
#4548 without closing it. The change is ready for review and is never merged by
this task.
