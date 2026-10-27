# Sidebar Recents

Stacked on the project header item. The existing sidebar registration is unchanged.

The presentation now follows `CompactChatHistory`, `HistoryRows` and
`ProjectRepositories`: Recents, Today, Previous 7 days, Previous 30 days, then
Older when needed. Archived records remain after live records. Rows use a
single truncated 13.5px / 300 title, dim 11.5px / 260 repository, 9.5px / 260
relative age and small branch/attention marks. The existing native theme owns
all colors and transparency. Date labels use 12px light text.

Groups disclose their remaining records after twelve rows. Search reveals all
matches. Down reveals the next undisclosed row and End reveals the final row;
stable thread identities and the existing uniform-list scroll handle keep the
keyboard choice in view. Selected threads retain their group's disclosure.
Relative ages refresh once a minute. Local midnight uses the platform calendar,
including daylight-saving resolution, without changing the shared manifest.

The existing thread discovery adapter returns branch identities from the same
state response it already reads. Session transcript headers remain unchanged.
No server route, persistence format or data decision is duplicated. The retained
inventory comparison still checks every production fixture thread, including
records behind Show more.

`sidebar_recents_groups_times_more_and_keyboard` writes timestamped messages
through the production history route, reads packet metadata through the real
state route, opens the real GPUI shell, clicks Show more and dispatches End/Enter.

Red before implementation:

```text
Recents must use desktop age groups rather than workspace/status shelves:
["Recent", "Recent", "Working", "Review", "Recent", "Workers", "Working", "Review", "Recent", "Recent"]
test result: FAILED. 0 passed; 1 failed; 169 filtered out
```

Green:

```text
test result: ok. 1 passed; 0 failed; 169 filtered out
```

The measurement probe now waits for HTTP connection and an actual painted
thread, with a bounded real-I/O wait; a section label is not a first-thread paint.
The previous whole-suite failure (0 discovered records) is retained as a failure,
not a performance receipt.

The native/current-UI screenshot pair remains unavailable on this Linux test
platform: its window draw method is a no-op and it uses a test text system.
Pixel, compositor, real-font and speed parity require a renderer-capable host.
The full-suite receipts and remaining failures are listed in the pull request.
