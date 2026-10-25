# Local server connection

One registration loads the connection module, including its state, lifecycle,
credential refresh, focus recovery and error view. Generic shell extension hooks
are optional and have defaults; other surface registrations are unchanged.

The CLI supplies a token-file descriptor only for its configured loopback origin
and file-based authority, including a file that does not exist yet. Explicit
bearers, workers and other origins cannot inherit that descriptor. Each connect
attempt reads the bounded file again. Credentials stay out of arguments, view
state and receipts.

Disconnect captures the focused control before showing connection state. A
successful reconnect restores that handle when its surface is still selected;
otherwise the selected surface restores its own focus. Existing views and drafts
remain in memory. Retry and the one-second refresh share one in-flight request.
