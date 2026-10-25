# Shell terminal and packet diff

The shell's Diff and Terminal registrations host the existing native views. Each
surface owns its inventory adapter, target selection and persisted target ID.
The shared target picker contains no routes or request policy. `client.rs` is
unchanged. Each surface moves its existing single registration from commands to
tabs; no second inventory is required.

Use Ctrl+K or Cmd+K, filter Open diff for a packet or Open terminal, and Enter.
Filter the resulting packet or terminal list and use Up/Down and Enter. Packet
and terminal choices are scoped to the selected canonical workspace. Only
existing terminals are attached; opening a picker does not spawn a shell.
Ctrl+Alt+O (Cmd+Alt+O) returns to that surface's target list; F5 retries a failed
list. Target rows retain their IDs across a list reorder. Closing the surface
detaches the viewer without terminating the owned PTY.

The same palette includes Switch workspace commands. Filter a workspace name and
Enter; Escape returns to the prior surface's focus. Open surfaces remain in
memory per workspace. Existing Ctrl+Tab and grid shortcuts retain their meaning.

The shell's versioned view state stores `diff_packet` and `terminal_session` in
the corresponding surface slices. Restoring an ID first checks current inventory;
a stale or foreign-workspace ID opens the picker. Credentials are never part of
the slices. The existing standalone terminal and diff entry points remain usable.
