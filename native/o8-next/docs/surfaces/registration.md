# Per-surface registration

The shell's `register_surfaces!` invocation is its only surface inventory. Each
entry loads a module in `src/surfaces/` and generates the typed command, tab,
content, runtime slot and persisted workspace slice. A new surface adds its own
files and one line to that invocation. The test-only `fake.rs` is a complete,
executable example, including command routing, paint, nav, keyboard and restart
state. Production builds exclude it.

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
   and live entities/subscriptions in `Runtime`. Keep the port's existing behavior.
3. Add exactly one entry, `<surface>: Variant = "surfaces/<surface>.rs";`, in the
   macro's `tabs` group (or `commands` for an overlay). Import the view in its own
   module. Remove the port's edits to `shell_state.rs` and `shell_view.rs`.
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
