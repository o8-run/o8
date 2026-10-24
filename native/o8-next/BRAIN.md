# Brain in o8 next

Open Brain from the shell command palette, or use Open Brain beside a selected
session. Ctrl+E / Cmd+E toggles the session panel; Escape minimizes it and restores
composer focus. Each session retains its Brain draft and conversation in memory.
Switching sessions minimizes the panel. The shell also offers a workspace Brain
tab; open tabs persist with the existing shell state, without conversation text.

Questions use the desktop's POST `/api/cortex/ask`, the selected server's operator
bearer, `conversation: true`, preferred runtime, workspace context and the last
six nonempty conversation messages (at most 1,000 UTF-16 units each). The server
owns retrieval, runtime selection and approval policy. Connected Brain inference
keeps its existing read-only / no-tools contract. Clear changes local conversation
state and cancels delivery to that view; it never deletes project memory.

Answers use the existing native Markdown rows and shared theme tokens. Source
chips show their titles and reveal excerpts on click. Search conversation or
Ctrl+F / Cmd+F filters local answer text and source metadata. Ask Brain performs
the existing server-side memory retrieval. Enter sends; Shift+Enter adds a line;
the shared native editor retains IME, Unicode, paste, selection and undo behavior.
Thinking, reading sources, runtime routing and errors are shown in the panel.
Empty, busy and unscoped sends are refused. Clearing an in-flight answer prevents
late events from repopulating the cleared conversation.

The SSE reader runs off the UI thread, follows no redirects or environment
proxies, uses the desktop's 270-second answer timeout and the native client's
16 MiB response bound. A bounded channel delivers frames to GPUI. A canceled
reader checks cancellation between reads; an outstanding network read can remain
until its timeout. No memory-write or approval endpoint is added.

## Verification

The disposable host's `--brain` mode loads the production route, middleware,
retrieval and citation translation over authored memory. Only connected-runtime
resolution and the runtime invocation are replaced, and the invocation asserts
`readOnly: true`. External fixture fetches fail locally. No account is used.
The request log is an optional fixture-owned file, without authorization headers.

```sh
npx vitest run tests/next-brain-real-path.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml brain_ -- --nocapture --test-threads=1
```

See [the parity table, red/green evidence and fixture measurements](evidence/brain/verification.md).

Desktop PR-detail prompt/context handoff has no native PR-detail counterpart in
this slice. The standalone workspace context is sent as source data. macOS visual
acceptance, native font shaping, GPU and compositor presentation were not measured
in the Linux headless fixture. The installed desktop app stays unchanged; all
entry points require the existing o8 next opt-in.
