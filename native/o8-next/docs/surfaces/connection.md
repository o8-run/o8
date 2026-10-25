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

The connection-owned transport adapter is selected by one root module path
registration. It delegates the existing transport primitives unchanged and shares
one transport snapshot among retained client clones. Reconnect replaces that
snapshot for all subsequent requests, including composer queue mutations and
WebSocket-info reacquisition. Independently authenticated clients retain separate
authority. A missing or malformed credential revokes retained request authority;
network I/O never holds the refresh lock. Workspace and opt-in desktop identity
remain scoped to each clone. Shared `src/client.rs` stays unchanged.

Initial resolution and reload use the same ordered CLI candidates: the current
profile token, then the legacy token. An explicitly configured data directory has
only its own candidate. The CLI makes paths absolute and binds the descriptor to
its selected numeric loopback origin. Native reload reads at most two bounded
files on each attempt, preserving the resolver's precedence independently of the
port file's directory. Worker, environment, explicit-native and other-origin
credentials do not inherit reload descriptors.
