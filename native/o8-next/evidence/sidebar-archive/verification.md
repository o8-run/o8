# Sidebar archive and restore

Stacked on the Recents item. This changes only the existing sidebar surface;
there is no new registration or shared-file edit.

Saved-thread rows reveal Archive or Restore on hover or keyboard focus. The
handler retains the row's thread ID, blocks duplicate mutations while saving
and does not activate another thread. Saved records use the desktop's PATCH
route with an ISO archivedAt value or null; transcript records are preserved.
Existing worker archive keeps its production runtime route and retry identity.

Archived is a bottom disclosure while collapsed. Opening it reveals the archived
rows after Recents and scrolls them into view. Search still includes archived
records. Its open list header can collapse it again. Keyboard Delete remains
available, and the old shortcut/helper labels have been removed.

The two GPUI tests drive actual mouse input and read both the saved record and
the production desktop list route. The action's geometry is checked against the
sidebar boundary; its width is constrained with the row instead of overflowing
beyond the visible rail.

Red before implementation:

```text
missing sidebar-archived
missing thread-archive-thoughts-sidebar-1999
test result: FAILED. 0 passed; 2 failed; 170 filtered out
```

Green:

```text
sidebar_row_unarchive_uses_desktop_metadata ... ok
sidebar_row_archive_uses_desktop_metadata ... ok
test result: ok. 2 passed; 0 failed; 170 filtered out
```

Runtime-worker restore remains unavailable: the existing runtime archive route
has GET state and POST archive, with no inverse restore operation. This item does
not add an alternate data path. Saved-thread archive and unarchive are covered.

The requested native/current-UI pixel pair remains open because this platform's
GPUI test window does not render pixels. Full All Glass, native font and speed
parity need a renderer-capable host. Whole-suite gate results and any remaining
failures are recorded in the pull request.
