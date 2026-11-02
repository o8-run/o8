# Local server connection

The discovered `shell_features/connection.rs` module registers itself with
`register_shell_feature!(Connection)`. Its window-local state lives in the feature
store. Optional lifecycle, overlay and capture hooks dispatch through the existing
surface adapter; the shared surface inventory gains no connection entry.

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
remain scoped to each clone. Shared `src/client.rs` exposes its existing GET deadline for the reconnect test;
transport request behavior is unchanged.

Initial resolution and reload use the same ordered CLI candidates: the current
profile token, then the legacy token. An explicitly configured data directory has
only its own candidate. The CLI makes paths absolute and binds the descriptor to
its selected numeric loopback origin. Native reload reads at most two bounded
files on each attempt, preserving the resolver's precedence independently of the
port file's directory. Worker, environment, explicit-native and other-origin
credentials do not inherit reload descriptors.

Palette keys dispatch from the discovered palette feature. Its render slot remains
in the Chrome group inside the retained `shell-chrome` region. Handled input
notifies the shell, invalidating both the cached scene and its measured height.
Window bounds and close persistence retain the existing window-state feature
observers. Connection subprocess cases rerun their parent tests in isolated child
mode; their bodies are helpers, so they add no ignored tests.

The reconnect test enforces the existing `LOAD_REQUEST_TIMEOUT + 5 seconds`
deadline before accepting a settled result. A parked executor returning after
a second blocked request cannot turn a late completion into a passing test.
