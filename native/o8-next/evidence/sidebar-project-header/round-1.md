# Review round 1: menu keyboard ownership

The project chooser retained the sidebar focus handle, so its Delete key fell
through to the selected saved row and issued a production history PATCH.

`sidebar_project_chooser_delete_sends_no_archive_request` selects a saved chat
through the native UI, opens the project chooser and presses Delete. A
surface-owned fixture observer counts actual archive requests before admission;
the mutation still uses the production route. The test checks zero requests and
unchanged saved archivedAt metadata.

Red on the uncorrected header head, with the test and request observer added:

```text
assertion `left == right` failed: Delete in the project chooser must send no archive request
  left: 1
 right: 0
test result: FAILED. 0 passed; 1 failed; 170 filtered out
```

The fix gives the open menu first handling of keyboard input before shell and
row shortcuts. The same handler protects both project choices and repository
overflow. Escape dismisses the menu while preserving the underlying search or
draft. A menu outside the focused sidebar does not intercept another surface.

`sidebar_header_menus_own_row_shortcuts_and_escape_preserves_rows` covers both
menus with Delete, Backspace, F2, Enter, Up, Down, Home, End, Ctrl+F and F8. It
checks unchanged row choice and editing state, zero archive requests and the
retained search on Escape. A positive control then presses Delete after closing
the menu and observes exactly one request and persisted archivedAt.

Green:

```text
sidebar_project_chooser_delete_sends_no_archive_request ... ok
sidebar_header_menus_own_row_shortcuts_and_escape_preserves_rows ... ok
test result: ok. 2 passed; 0 failed; 169 filtered out
```

The original `sidebar_project_header_switches_repos_and_projects` test and the
13 focused TypeScript cases are retained unchanged. Gate and stack-rebase
receipts are recorded in the pull request.
