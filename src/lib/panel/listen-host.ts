// Bind address for o8's local servers (the Next API server on the 47100 block
// and the ws-server on the 47105 block).
//
// Default: loopback only. Every desktop caller (the Tauri webview, the Rust
// sidecar, the CLI, the MCP bridges) reaches these servers at 127.0.0.1, so
// nothing on the machine needs a wildcard bind — and a wildcard bind exposes
// the API and the terminal/agent WebSocket to every host on the LAN/VPN.
//
// Opt-in: `O8_LAN_ACCESS=1` binds 0.0.0.0 so a phone on the same Wi-Fi or
// tailnet can reach this machine directly (QR mobile pairing / the mobile web
// client). Requests from non-loopback peers still need the ws-token or a
// per-device token; this only controls whether the sockets are reachable.

export const LOOPBACK_LISTEN_HOST = '127.0.0.1';
export const LAN_LISTEN_HOST = '0.0.0.0';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** True when the operator explicitly opted in to LAN/tailnet reachability. */
export function lanAccessEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return TRUTHY.has((env.O8_LAN_ACCESS ?? '').trim().toLowerCase());
}

/** Host for `server.listen(port, host)` on o8's local servers. */
export function resolveListenHost(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return lanAccessEnabled(env) ? LAN_LISTEN_HOST : LOOPBACK_LISTEN_HOST;
}
