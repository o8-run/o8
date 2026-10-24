# Grid slot terminal verification

The server and keyboard regressions were run before their fixes. The unchanged
red output is retained in [red-server.txt](red-server.txt) and
[red-rust.txt](red-rust.txt). Tests cross the production fixture HTTP handlers,
production WebSocket server, real fixture PTYs and the GPUI root.

The fixture follows the README dev-server pattern. No accounts, operator
application state or visible windows are used. The shipped Tauri app is unchanged.

Measurements and final completion receipts are recorded below after verification.
