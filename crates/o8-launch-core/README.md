# Shared launch mechanics

Pure Rust mechanics extracted from the classic shell for the opt-in launcher
in step 3 of #6130. The shell imports the same implementations. This crate has
no Tauri or web view dependency. It does not change bundle selection.

- `preflight`: Node discovery, supported ABI policy and Linux native addon checks.
- `shell_env`: login-shell probe and binary-stamped Node version cache.
- `ports`: occupied-port rejection, allocation probes and LAN bind opt-in.
- `restart`: the existing three-restart budget over five minutes, with 750 ms delay.
- `next_main_startup`: the authenticated server-owned window request and failure reporting.
- `no_window`, `windows_node_locate`: existing cross-platform support.

Run `cargo test --locked --manifest-path crates/o8-launch-core/Cargo.toml`.
The macOS extraction run passed all 16 tests. The classic shell cannot be checked
in a source-only checkout without its generated helpers and frontend assets.

This is the first layer of a split change. The launcher binary and its real-entry
fixtures belong to the next layer. Launch ownership, shutdown and native Dock
handling are not provided by this library alone.
