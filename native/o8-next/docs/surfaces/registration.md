# Per-surface registration

The shell's `register_surfaces!` invocation is its only surface inventory. Each
entry loads a module in `src/surfaces/` and generates the typed command, tab,
content, runtime slot and persisted workspace slice. A new surface adds its own
files and one line to that invocation. The test-only `fake.rs` is a complete,
executable example, including command routing, an authenticated HTTP request,
paint, nav, keyboard and restart state. Production builds exclude it.

A tab module supplies `View`, `Slice`, `Runtime` and `REGISTRATION`, and implements
`ShellView` for its view. `Slice` is serialized into the existing workspace object;
use defaults and omit empty optional fields when adding state. Stateless surfaces
use `EmptyState` and `()`. The session slice keeps the original `composer` and
`selections` keys. Existing tab discriminators and shell-state version stay the
same. Overlay commands supply their own runtime, view and focus hooks without
becoming persisted tabs. Diff and terminal commands retain their unavailable
notice until their ports land.

`REGISTRATION` owns the command label/order and opening action, lazy view factory,
nav controls, keyboard bindings, capture/close hooks and optional workspace
loading. `NavPosition` keeps existing controls on their original side of the
workspace list. Keyboard hooks run before the shared shell shortcuts, as Settings
did before extraction. Only shared palette, workspace and tab lifecycle behavior
belongs in the shell. A surface may include its own `#[cfg(test)] mod tests`;
`test_support` supplies the existing production-host fixture and GPUI helpers.

Surface requests belong in that same surface module as inherent `impl Client`
methods (or in a child request module it includes). The shell's one registration
entry loads the module and its request methods together; no request list or
`client.rs` edit is needed. Keep route paths, queries, bodies, response decoding
and surface-specific error messages there. Use shared transport helpers:
`Client::get` for JSON reads, or `Client::url`, `Client::request` and `Client::read`
for other methods. `request` applies the existing operator bearer, redirect and
timeout policy; only existing desktop-identity endpoints opt in through
`with_desktop_identity`. Streaming adapters retain their own existing framing and
limits. `client.rs` holds the transport and compatibility type reexports.

The disposable HTTP host discovers sorted `scripts/next/surfaces/*.surface.ts`
files. Each exports an async default registration returning its route map and
optional request, response, streaming and cleanup hooks. An optional `prepare`
export runs before production imports, for Settings profile/process isolation.
Route `priority` preserves overlapping fixture route precedence independently of
initialization order. Keep imports of production handlers inside registration,
after fixture isolation. `admit` retains each fixture's owned-target checks; the
shared host still applies production middleware. `early` preserves the existing
terminal status handshake. New registrations should use the normal gated path.

## How open ports rebase onto this

1. Rebase the port onto the main revision containing this refactor. Resolve its
   shared registration hunks by keeping main's dispatcher and registration macro.
2. Move the port's command/route, workspace state fields, view factory, nav and
   key handling into `src/surfaces/<surface>.rs`. Put persisted fields in `Slice`
   and live entities/subscriptions in `Runtime`. Move its request methods (for
   example `activity_request`) into an `impl Client` in that same module, using
   the shared transport helpers above. Keep the port's existing behavior.
3. Add exactly one entry, `<surface>: Variant = "surfaces/<surface>.rs";`, in the
   macro's `tabs` group (or `commands` for an overlay). Import the view in its own
   module. Remove the port's edits to `shell_state.rs`, `shell_view.rs` and
   `client.rs`; the same entry also compiles its request methods.
4. Include the port's tests from that surface module. Keep test function names;
   use `crate::shell::test_support` for shared fixture helpers. Remove additions
   to `shell_tests.rs`.
5. Move the port's fixture route registrations and associated hooks into a new
   `scripts/next/surfaces/<order>-<surface>.surface.ts`. Remove its route-table
   and route-identity branches from `dev-server.ts`; discovery loads the new file.
6. Add `docs/surfaces/<surface>.md` instead of editing native README paragraphs.
   Run `npm run test:classify`, the existing surface tests and required gates.

This refactor precedes the remaining open ports. It registers the surfaces already
on main; it does not enable unlanded Activity, pull-request, file, commit, diff,
Customize, shortcuts, first-run or stack-review ports. Those ports follow the same
module contract when they rebase. Sidebar selection remains in the session view,
with its shell regression owned by the session test module.

## CI boundary

The `o8 next surface boundary` PR check runs for changes under `native/o8-next/`
or `scripts/next/`. It rejects shared shell files (including shell helpers/tests),
the surface registry, `client.rs`, the crate entry point, shared renderer files
(`ui`, `model`, `retained`, `rich`, `text`, `theme`, `render*` and `composer*`), and the fixture
host's `dev-server.ts` and `surface-routes.ts`. The explicit inventory lives in
`scripts/next/check-surface-boundary.mjs`.

The only shared exception is one added entry inside `shell.rs`'s registration
macro. Counts are additions plus deletions: replacing a line counts as two, and
renaming or deleting a shared file is checked too. Each refusal reports the path
and changed-line count on one line. Intentional shell work must carry the exact
`shell-work` PR label; that label exempts the boundary and isolated build. Adding
or removing the label reruns the check. Ordinary CI still applies.

For surface work, the check creates a disposable worktree at current main, applies
only the PR's Rust surface files and discovered fixture entries, inserts its one
registration without removing entries landed since the PR branched, and runs
`cargo check --all-targets --locked --manifest-path native/o8-next/Cargo.toml`.
It excludes shared edits, manifests, build scripts and vendor changes. Keep any
support the port needs inside its own included modules. Both native tests and
production code must compile. The check cleans up on success or failure and
reports wall time in the CI log and job summary; CI caches Cargo dependencies and
build output, and refuses shared edits before restoring that cache.

Run the same entry point locally after fetching main:

```sh
node scripts/next/check-surface-boundary.mjs --base origin/main --head HEAD
npx vitest run tests/next-surface-boundary-real-path.test.ts
```

For a local shell-work check, supply `--event FILE` with the GitHub PR event
containing its labels. CI reads the event from `GITHUB_EVENT_PATH`.
