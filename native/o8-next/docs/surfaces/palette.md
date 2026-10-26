# Palette module

One shell inventory line loads the palette, including its renderer, query and
selection handling, workspace commands, target-picker widget and tests. Dynamic
workspace entries are private to this module; the shared Command enum contains
only registered surfaces and the existing message command. The optional
ShellExtension defaults to no behavior, so other registrations compile unchanged.
Its propagation result lets a focused control receive a key before the legacy
shell shortcut can consume it.

Cmd/Ctrl+Shift+P is the explicit global palette chord. Ctrl/Cmd+K also opens it
from chrome or a read-only session/grid, and stays with a focused editor or
terminal. Session and grid expose a narrow reading-focus query; nested editors
are distinct from that read-only focus. Unknown focused surfaces retain their
keys. Escape restores focus to the selected surface. The Commands button remains
available without transferring keys from another control.

Palette-intent tests use the explicit global chord. Ownership tests deliberately
use Ctrl/Cmd+K; the terminal fixture acknowledges byte 0x0b through the real PTY.
Requests and persisted target IDs remain in the Diff and Terminal modules.

The shared ShellExtension dispatch is shell work under the surface-boundary
policy. The PR must carry `shell-work` with a reason for those shared hooks;
main's trusted checker enforces that classification. Whole-shell compilation
includes the shared protocol and the registered palette together.

Before handling palette navigation, the module honors registered keyboard guards,
including Setup's busy state. Focused editor/terminal Ctrl/Cmd+K propagation still
returns before those palette navigation handlers run. Global palette shortcuts
resume after the registered guard releases.
