// Bind address for o8's local servers (the Next API server on the 47100 block
// and the ws-server on the 47105 block).
//
// Default: loopback only. Every desktop caller (the Tauri webview, the Rust
// sidecar, the CLI, the MCP bridges) reaches these servers at 127.0.0.1, so
// nothing on the machine needs a wildcard bind — and a wildcard bind exposes
// the API and the terminal/agent WebSocket to every host on the LAN/VPN.
//
// Phone access is off by default. The saved setting opts in to a wildcard
// bind; an explicit O8_LAN_ACCESS value takes precedence. Network callers
// still require their bearer credential.

export const LOOPBACK_LISTEN_HOST = '127.0.0.1';
export const LAN_LISTEN_HOST = '0.0.0.0';

import { lanAccessEnabled } from '../../../scripts/lib/lan-access.cjs';
export { lanAccessEnabled };

/** Host for `server.listen(port, host)` on o8's local servers. */
export function resolveListenHost(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return lanAccessEnabled(env) ? LAN_LISTEN_HOST : LOOPBACK_LISTEN_HOST;
}
