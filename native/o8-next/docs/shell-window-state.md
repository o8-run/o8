# Shell window state

The shell restores its existing versioned view-state file: window position and
size, selected workspace, open surfaces, active surface, sidebar selection and
session/composer focus. Opening the command palette does not replace the focus
that is restored on restart. Surface-owned state remains in registered modules.

A missing, malformed, incompatible, oversized or invalid-geometry file opens the
default window. Reads remain bounded to 1 MiB plus one byte. Loading does not
write the file; normal later persistence replaces an unusable file with current
view state. Read/write I/O failures retain their existing errors. Save validation,
atomic replacement and owner-only permissions are unchanged.

The state file contains view state, never credentials or message drafts. The
standalone shell's local token resolver remains in its CLI launcher.
