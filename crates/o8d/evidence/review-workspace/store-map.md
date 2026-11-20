# Workspace review ownership

| Case/input | Owner |
| --- | --- |
| No workspace query and no CORTEX_IDE_REVIEW_REPO_ROOT | Shared TS selection predicate attests one boolean during existing private auth admission; Rust builds the original empty response. No store or process cache is read or changed by this early response. |
| Explicit workspace or configured default root | Original TS handler retains path validation, Git status/diff/log/worktree discovery and GitHub quota/cache behavior. Missing/malformed/error cases retain its exact status and body. |
| Full/changed-files review caches and command-center generation | Existing TS cache owner; native unselected reads do not fill, invalidate or suppress it, matching the original early branch. |
| Git index/object/config work | Owned fixture setup and original TS selected requests. Rust never opens a repository in this state. |
| ws-token and counts-only JSONL | Existing middleware/bridge authorizes each request; the original recorder writes counts. No credential enters the private context or corpus. |

The test seeds a real account-free repository with fixed commit identity/time and an owned gh stand-in. Its strace receipt comes from initialization and the original TS oracle before native admission existed; writable Git files include fixture setup and selected-handler index coordination. Every native generated response independently verifies durable before/after content hashes. Raw traces remain local; the committed summary has relative owned paths only.

Issue #6398. No new caller, Rust writer, mobile shape, route deletion or write-seat mutation. The route remains rust-with-fallback until selected review behavior is ported separately.
