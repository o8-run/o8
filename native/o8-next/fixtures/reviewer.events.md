# Reviewer readback fixture

A reduced, sanitized shape from a recorded read-only reviewer session on
2026-11-02. The two diff commands were unwrapped from the recorded execution
batch. Call identifiers, timestamps, result summaries and verdict wording are
shortened or replaced; paths are repository-relative. No host identities or
private runtime output are retained.

`reviewer.events.json` uses the server's `TranscriptEvent` wire contract from
`src/lib/orchestrator/transcript-normalizer.ts`: calls, paired results, assistant
verdict, then done. `worker_transcript_tests.rs` also exercises the running prefix
and an error/done suffix through the native history reader and GPUI viewport.
